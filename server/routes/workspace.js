import crypto from 'node:crypto';
import { getAuth } from '@clerk/express';
import { requireSupabase } from '../db/supabase.js';
import { logger } from '../logger.js';
import { isWorkspaceReadOnly, refreshExpiredBillingState } from '../services/billing.js';
import { getPlanForTier } from '../services/plans.js';

const validArtifactTypes = new Set([
  'sequence-diagram',
  'class-diagram',
  'activity-diagram',
  'state-machine-diagram',
]);
const validAccessLevels = new Set(['view', 'edit']);
const validVisibility = new Set(['private', 'public']);

const mapProject = (row) => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  name: row.name,
  description: row.description,
  visibility: row.visibility,
  publicAccess: row.public_access,
  shareToken: row.share_token,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapArtifact = (row) => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  projectId: row.project_id,
  name: row.name,
  type: row.type,
  content: row.content,
  shareToken: row.share_token,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapGrant = (row) => ({
  id: row.id,
  projectId: row.project_id,
  email: row.email,
  access: row.access,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const normalizeText = (value) => String(value || '').trim();
const normalizeEmail = (value) => normalizeText(value).toLowerCase();
const createToken = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const tokenPrefix = (value) => normalizeText(value).slice(0, 12);
const isDuplicateArtifactNameError = (error) =>
  error?.code === '23505' && error?.message?.includes('artifacts_project_name_unique');

const buildLimitError = (plan, limitName, limit, currentUsage) => ({
  error: 'PLAN_LIMIT_REACHED',
  message: `${plan.label} plan allows up to ${limit} ${limitName}.`,
  limit,
  currentUsage,
  upgradeRequired: true,
});

const readonlyError = () => ({
  error: 'WORKSPACE_READ_ONLY',
  message:
    'Your workspace is read-only because the paid plan grace period ended. Upgrade to continue making changes.',
  upgradeRequired: true,
});

const countRows = async (query) => {
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
};

const getUsageCounts = async (db, ownerUserId) => {
  const [projects, artifacts, shareLinks] = await Promise.all([
    countRows(
      db
        .from('eu_projects')
        .select('id', { count: 'exact', head: true })
        .eq('owner_user_id', ownerUserId),
    ),
    countRows(
      db
        .from('eu_artifacts')
        .select('id', { count: 'exact', head: true })
        .eq('owner_user_id', ownerUserId),
    ),
    countRows(
      db
        .from('eu_artifacts')
        .select('id', { count: 'exact', head: true })
        .eq('owner_user_id', ownerUserId)
        .not('share_token', 'is', null),
    ),
  ]);

  return { projects, artifacts, shareLinks };
};

const getAppUser = async (db, clerkUserId) => {
  const { data, error } = await db
    .from('eu_app_users')
    .select('id, tier, billing_status, billing_grace_ends_at, workspace_mode')
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    logger.warn('auth.profile.not_synced', {
      clerkUserId,
    });
    const notFound = new Error('User profile has not been synced yet.');
    notFound.status = 404;
    notFound.code = 'PROFILE_NOT_FOUND';
    throw notFound;
  }

  return refreshExpiredBillingState(db, data);
};

const ensureWorkspaceWritable = (appUser, response, fields = {}) => {
  if (!isWorkspaceReadOnly(appUser)) {
    return true;
  }

  logger.warn('workspace.write.read_only_blocked', {
    billingStatus: appUser.billing_status,
    userId: appUser.id,
    ...fields,
  });
  response.status(403).json(readonlyError());
  return false;
};

const getOwnedProject = async (db, projectId, ownerUserId) => {
  const { data, error } = await db
    .from('eu_projects')
    .select()
    .eq('id', projectId)
    .eq('owner_user_id', ownerUserId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    logger.warn('project.lookup.not_found', {
      ownerUserId,
      projectId,
    });
    const notFound = new Error('Project was not found.');
    notFound.status = 404;
    notFound.code = 'PROJECT_NOT_FOUND';
    throw notFound;
  }

  return data;
};

export const listWorkspace = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);

    const [projectsResult, artifactsResult, grantsResult] = await Promise.all([
      db.from('eu_projects').select().eq('owner_user_id', appUser.id).order('updated_at', { ascending: false }),
      db.from('eu_artifacts').select().eq('owner_user_id', appUser.id).order('updated_at', { ascending: false }),
      db.from('eu_project_access_grants').select('*, eu_projects!inner(owner_user_id)').eq('eu_projects.owner_user_id', appUser.id),
    ]);

    if (projectsResult.error) throw projectsResult.error;
    if (artifactsResult.error) throw artifactsResult.error;
    if (grantsResult.error) throw grantsResult.error;

    response.json({
      projects: projectsResult.data.map(mapProject),
      artifacts: artifactsResult.data.map(mapArtifact),
      grants: grantsResult.data.map(mapGrant),
    });

    logger.info('workspace.list.success', {
      artifactCount: artifactsResult.data.length,
      grantCount: grantsResult.data.length,
      projectCount: projectsResult.data.length,
      requestId: request.id,
      userId: appUser.id,
    });
  } catch (error) {
    next(error);
  }
};

export const createProject = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    if (!ensureWorkspaceWritable(appUser, response, { requestId: request.id })) {
      return;
    }
    const name = normalizeText(request.body.name) || 'Untitled Project';
    const plan = await getPlanForTier(db, appUser.tier);
    const usage = await getUsageCounts(db, appUser.id);

    if (usage.projects >= plan.maxProjects) {
      logger.warn('project.create.limit_reached', {
        currentUsage: usage.projects,
        limit: plan.maxProjects,
        planTier: plan.tier,
        requestId: request.id,
        userId: appUser.id,
      });
      response.status(403).json(
        buildLimitError(plan, 'projects', plan.maxProjects, usage.projects),
      );
      return;
    }

    const { data, error } = await db
      .from('eu_projects')
      .insert({
        owner_user_id: appUser.id,
        name,
        visibility: 'private',
      })
      .select()
      .single();

    if (error) throw error;

    logger.info('project.create.success', {
      projectId: data.id,
      requestId: request.id,
      userId: appUser.id,
    });

    response.status(201).json({ project: mapProject(data) });
  } catch (error) {
    next(error);
  }
};

export const updateProject = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    if (!ensureWorkspaceWritable(appUser, response, { requestId: request.id })) {
      return;
    }
    const existingProject = await getOwnedProject(db, request.params.projectId, appUser.id);

    const patch = { updated_at: new Date().toISOString() };
    const name = normalizeText(request.body.name);
    const description = normalizeText(request.body.description);
    const visibility = request.body.visibility;
    const publicAccess = request.body.publicAccess;

    if (name) patch.name = name;
    if ('description' in request.body) patch.description = description || null;
    if (validVisibility.has(visibility)) patch.visibility = visibility;
    if (validAccessLevels.has(publicAccess)) patch.public_access = publicAccess;
    if ((validVisibility.has(visibility) || validAccessLevels.has(publicAccess)) && !existingProject.share_token) {
      patch.share_token = createToken('project-share');
    }

    const { data, error } = await db
      .from('eu_projects')
      .update(patch)
      .eq('id', request.params.projectId)
      .eq('owner_user_id', appUser.id)
      .select()
      .single();

    if (error) throw error;

    logger.info('project.update.success', {
      projectId: data.id,
      requestId: request.id,
      userId: appUser.id,
      visibility: data.visibility,
    });

    response.json({ project: mapProject(data) });
  } catch (error) {
    next(error);
  }
};

export const deleteProject = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    if (!ensureWorkspaceWritable(appUser, response, { requestId: request.id })) {
      return;
    }
    await getOwnedProject(db, request.params.projectId, appUser.id);

    const { error } = await db
      .from('eu_projects')
      .delete()
      .eq('id', request.params.projectId)
      .eq('owner_user_id', appUser.id);

    if (error) throw error;

    logger.info('project.delete.success', {
      projectId: request.params.projectId,
      requestId: request.id,
      userId: appUser.id,
    });

    response.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const saveArtifact = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    if (!ensureWorkspaceWritable(appUser, response, { requestId: request.id })) {
      return;
    }
    await getOwnedProject(db, request.body.projectId, appUser.id);
    const plan = await getPlanForTier(db, appUser.tier);
    const usage = await getUsageCounts(db, appUser.id);

    const name = normalizeText(request.body.name) || 'Untitled Diagram';
    const type = request.body.type;
    const content = String(request.body.content || '');

    if (!validArtifactTypes.has(type)) {
      logger.warn('artifact.save.invalid_type', {
        artifactId: request.body.artifactId,
        requestId: request.id,
        type,
        userId: appUser.id,
      });
      response.status(400).json({
        error: 'INVALID_ARTIFACT_TYPE',
        message: 'Artifact type is not supported.',
      });
      return;
    }

    if (!request.body.artifactId && usage.artifacts >= plan.maxArtifacts) {
      logger.warn('artifact.save.limit_reached', {
        currentUsage: usage.artifacts,
        limit: plan.maxArtifacts,
        planTier: plan.tier,
        requestId: request.id,
        userId: appUser.id,
      });
      response.status(403).json(
        buildLimitError(plan, 'UML files', plan.maxArtifacts, usage.artifacts),
      );
      return;
    }

    const payload = {
      owner_user_id: appUser.id,
      project_id: request.body.projectId,
      name,
      type,
      content,
      updated_at: new Date().toISOString(),
    };

    const query = request.body.artifactId
      ? db
          .from('eu_artifacts')
          .update(payload)
          .eq('id', request.body.artifactId)
          .eq('owner_user_id', appUser.id)
      : db.from('eu_artifacts').insert(payload);

    const { data, error } = await query.select().single();

    if (error) {
      if (isDuplicateArtifactNameError(error)) {
        logger.warn('artifact.save.duplicate_name', {
          artifactId: request.body.artifactId,
          name,
          projectId: request.body.projectId,
          requestId: request.id,
          userId: appUser.id,
        });
        const duplicateName = new Error('A UML file with this name already exists in the project.');
        duplicateName.status = 409;
        duplicateName.code = 'DUPLICATE_ARTIFACT_NAME';
        throw duplicateName;
      }

      throw error;
    }

    logger.info('artifact.save.success', {
      artifactId: data.id,
      isUpdate: Boolean(request.body.artifactId),
      projectId: data.project_id,
      requestId: request.id,
      type: data.type,
      userId: appUser.id,
    });

    response.status(request.body.artifactId ? 200 : 201).json({ artifact: mapArtifact(data) });
  } catch (error) {
    next(error);
  }
};

export const deleteArtifact = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    if (!ensureWorkspaceWritable(appUser, response, { requestId: request.id })) {
      return;
    }

    const { error } = await db
      .from('eu_artifacts')
      .delete()
      .eq('id', request.params.artifactId)
      .eq('owner_user_id', appUser.id);

    if (error) throw error;

    logger.info('artifact.delete.success', {
      artifactId: request.params.artifactId,
      requestId: request.id,
      userId: appUser.id,
    });

    response.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const createArtifactShareLink = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    if (!ensureWorkspaceWritable(appUser, response, { requestId: request.id })) {
      return;
    }
    const plan = await getPlanForTier(db, appUser.tier);
    const usage = await getUsageCounts(db, appUser.id);

    const { data: existing, error: existingError } = await db
      .from('eu_artifacts')
      .select()
      .eq('id', request.params.artifactId)
      .eq('owner_user_id', appUser.id)
      .maybeSingle();

    if (existingError) throw existingError;

    if (!existing) {
      logger.warn('artifact.share.create.not_found', {
        artifactId: request.params.artifactId,
        requestId: request.id,
        userId: appUser.id,
      });
      response.status(404).json({
        error: 'ARTIFACT_NOT_FOUND',
        message: 'Artifact was not found.',
      });
      return;
    }

    if (existing.share_token) {
      logger.info('artifact.share.create.reused', {
        artifactId: existing.id,
        requestId: request.id,
        tokenPrefix: tokenPrefix(existing.share_token),
        userId: appUser.id,
      });
      response.json({ artifact: mapArtifact(existing) });
      return;
    }

    if (usage.shareLinks >= plan.maxShareLinks) {
      logger.warn('artifact.share.create.limit_reached', {
        currentUsage: usage.shareLinks,
        limit: plan.maxShareLinks,
        planTier: plan.tier,
        requestId: request.id,
        userId: appUser.id,
      });
      response.status(403).json(
        buildLimitError(
          plan,
          'active share links',
          plan.maxShareLinks,
          usage.shareLinks,
        ),
      );
      return;
    }

    const { data, error } = await db
      .from('eu_artifacts')
      .update({
        share_token: createToken('share'),
        updated_at: new Date().toISOString(),
      })
      .eq('id', request.params.artifactId)
      .eq('owner_user_id', appUser.id)
      .select()
      .single();

    if (error) throw error;

    logger.info('artifact.share.create.success', {
      artifactId: data.id,
      requestId: request.id,
      tokenPrefix: tokenPrefix(data.share_token),
      userId: appUser.id,
    });

    response.json({ artifact: mapArtifact(data) });
  } catch (error) {
    next(error);
  }
};

export const revokeArtifactShareLink = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    if (!ensureWorkspaceWritable(appUser, response, { requestId: request.id })) {
      return;
    }

    const { data, error } = await db
      .from('eu_artifacts')
      .update({
        share_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', request.params.artifactId)
      .eq('owner_user_id', appUser.id)
      .select()
      .single();

    if (error) throw error;

    logger.info('artifact.share.revoke.success', {
      artifactId: data.id,
      requestId: request.id,
      userId: appUser.id,
    });

    response.json({ artifact: mapArtifact(data) });
  } catch (error) {
    next(error);
  }
};

export const addProjectGrant = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    if (!ensureWorkspaceWritable(appUser, response, { requestId: request.id })) {
      return;
    }
    await getOwnedProject(db, request.params.projectId, appUser.id);

    const email = normalizeEmail(request.body.email);
    const access = request.body.access;

    if (!email || !validAccessLevels.has(access)) {
      logger.warn('project.grant.invalid', {
        access,
        hasEmail: Boolean(email),
        projectId: request.params.projectId,
        requestId: request.id,
        userId: appUser.id,
      });
      response.status(400).json({
        error: 'INVALID_GRANT',
        message: 'A valid email and access level are required.',
      });
      return;
    }

    const { data, error } = await db
      .from('eu_project_access_grants')
      .upsert(
        {
          project_id: request.params.projectId,
          email,
          access,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'project_id,email' },
      )
      .select()
      .single();

    if (error) throw error;

    logger.info('project.grant.upsert.success', {
      access: data.access,
      grantId: data.id,
      projectId: data.project_id,
      requestId: request.id,
      userId: appUser.id,
    });

    response.status(201).json({ grant: mapGrant(data) });
  } catch (error) {
    next(error);
  }
};

export const revokeProjectGrant = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    if (!ensureWorkspaceWritable(appUser, response, { requestId: request.id })) {
      return;
    }

    const { data: grant, error: grantError } = await db
      .from('eu_project_access_grants')
      .select('id, eu_projects!inner(owner_user_id)')
      .eq('id', request.params.grantId)
      .eq('eu_projects.owner_user_id', appUser.id)
      .maybeSingle();

    if (grantError) throw grantError;

    if (!grant) {
      logger.warn('project.grant.revoke.not_found', {
        grantId: request.params.grantId,
        requestId: request.id,
        userId: appUser.id,
      });
      response.status(404).json({
        error: 'GRANT_NOT_FOUND',
        message: 'Project access grant was not found.',
      });
      return;
    }

    const { error } = await db
      .from('eu_project_access_grants')
      .delete()
      .eq('id', request.params.grantId);

    if (error) throw error;

    logger.info('project.grant.revoke.success', {
      grantId: request.params.grantId,
      requestId: request.id,
      userId: appUser.id,
    });

    response.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const getSharedArtifact = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const shareToken = normalizeText(request.params.shareToken);

    logger.info('shared.artifact.lookup.start', {
      requestId: request.id,
      tokenPrefix: tokenPrefix(shareToken),
    });

    const { data, error } = await db
      .from('eu_artifacts')
      .select()
      .eq('share_token', shareToken)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      logger.warn('shared.artifact.lookup.not_found', {
        requestId: request.id,
        tokenPrefix: tokenPrefix(shareToken),
      });
      response.status(404).json({
        error: 'SHARED_ARTIFACT_NOT_FOUND',
        message: 'Shared UML file was not found.',
      });
      return;
    }

    logger.info('shared.artifact.lookup.success', {
      artifactId: data.id,
      projectId: data.project_id,
      requestId: request.id,
      tokenPrefix: tokenPrefix(shareToken),
    });

    response.json({ artifact: mapArtifact(data), access: 'view' });
  } catch (error) {
    next(error);
  }
};

export const getSharedProject = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const shareToken = normalizeText(request.params.shareToken);

    logger.info('shared.project.lookup.start', {
      requestId: request.id,
      tokenPrefix: tokenPrefix(shareToken),
    });

    const { data: project, error: projectError } = await db
      .from('eu_projects')
      .select()
      .eq('share_token', shareToken)
      .maybeSingle();

    if (projectError) throw projectError;

    if (!project) {
      logger.warn('shared.project.lookup.not_found', {
        requestId: request.id,
        tokenPrefix: tokenPrefix(shareToken),
      });
      response.status(404).json({
        error: 'SHARED_PROJECT_NOT_FOUND',
        message: 'Shared project was not found.',
      });
      return;
    }

    let access = 'none';
    let source = 'none';

    if (project.visibility === 'public' && project.public_access) {
      access = project.public_access;
      source = 'public';
    }

    const auth = getAuth(request);
    if (auth.isAuthenticated && auth.userId) {
      const { data: appUser, error: userError } = await db
        .from('eu_app_users')
        .select('id, email')
        .eq('clerk_user_id', auth.userId)
        .maybeSingle();

      if (userError) throw userError;

      if (appUser?.id === project.owner_user_id) {
        access = 'edit';
        source = 'owner';
      } else if (appUser?.email) {
        const { data: grant, error: grantError } = await db
          .from('eu_project_access_grants')
          .select('access')
          .eq('project_id', project.id)
          .eq('email', normalizeEmail(appUser.email))
          .maybeSingle();

        if (grantError) throw grantError;

        if (grant) {
          access = grant.access;
          source = 'private-grant';
        }
      }
    }

    if (access === 'none') {
      logger.warn('shared.project.access_denied', {
        projectId: project.id,
        requestId: request.id,
        source,
        tokenPrefix: tokenPrefix(shareToken),
      });
      response.status(403).json({
        error: 'SHARED_PROJECT_ACCESS_DENIED',
        message: 'You do not have access to this shared project.',
      });
      return;
    }

    const { data: artifacts, error: artifactsError } = await db
      .from('eu_artifacts')
      .select()
      .eq('project_id', project.id)
      .order('updated_at', { ascending: false });

    if (artifactsError) throw artifactsError;

    logger.info('shared.project.lookup.success', {
      access,
      artifactCount: artifacts.length,
      projectId: project.id,
      requestId: request.id,
      source,
      tokenPrefix: tokenPrefix(shareToken),
    });

    response.json({
      project: mapProject(project),
      artifacts: artifacts.map(mapArtifact),
      access,
      source,
    });
  } catch (error) {
    next(error);
  }
};
