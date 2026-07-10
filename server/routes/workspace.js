import crypto from 'node:crypto';
import { getAuth } from '@clerk/express';
import { requireSupabase } from '../db/supabase.js';

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

const getAppUser = async (db, clerkUserId) => {
  const { data, error } = await db
    .from('app_users')
    .select('id, tier')
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const notFound = new Error('User profile has not been synced yet.');
    notFound.status = 404;
    notFound.code = 'PROFILE_NOT_FOUND';
    throw notFound;
  }

  return data;
};

const getOwnedProject = async (db, projectId, ownerUserId) => {
  const { data, error } = await db
    .from('projects')
    .select()
    .eq('id', projectId)
    .eq('owner_user_id', ownerUserId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
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
      db.from('projects').select().eq('owner_user_id', appUser.id).order('updated_at', { ascending: false }),
      db.from('artifacts').select().eq('owner_user_id', appUser.id).order('updated_at', { ascending: false }),
      db.from('project_access_grants').select('*, projects!inner(owner_user_id)').eq('projects.owner_user_id', appUser.id),
    ]);

    if (projectsResult.error) throw projectsResult.error;
    if (artifactsResult.error) throw artifactsResult.error;
    if (grantsResult.error) throw grantsResult.error;

    response.json({
      projects: projectsResult.data.map(mapProject),
      artifacts: artifactsResult.data.map(mapArtifact),
      grants: grantsResult.data.map(mapGrant),
    });
  } catch (error) {
    next(error);
  }
};

export const createProject = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    const name = normalizeText(request.body.name) || 'Untitled Project';

    const { data, error } = await db
      .from('projects')
      .insert({
        owner_user_id: appUser.id,
        name,
        visibility: 'private',
      })
      .select()
      .single();

    if (error) throw error;

    response.status(201).json({ project: mapProject(data) });
  } catch (error) {
    next(error);
  }
};

export const updateProject = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
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
      .from('projects')
      .update(patch)
      .eq('id', request.params.projectId)
      .eq('owner_user_id', appUser.id)
      .select()
      .single();

    if (error) throw error;

    response.json({ project: mapProject(data) });
  } catch (error) {
    next(error);
  }
};

export const deleteProject = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    await getOwnedProject(db, request.params.projectId, appUser.id);

    const { error } = await db
      .from('projects')
      .delete()
      .eq('id', request.params.projectId)
      .eq('owner_user_id', appUser.id);

    if (error) throw error;

    response.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const saveArtifact = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    await getOwnedProject(db, request.body.projectId, appUser.id);

    const name = normalizeText(request.body.name) || 'Untitled Diagram';
    const type = request.body.type;
    const content = String(request.body.content || '');

    if (!validArtifactTypes.has(type)) {
      response.status(400).json({
        error: 'INVALID_ARTIFACT_TYPE',
        message: 'Artifact type is not supported.',
      });
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
          .from('artifacts')
          .update(payload)
          .eq('id', request.body.artifactId)
          .eq('owner_user_id', appUser.id)
      : db.from('artifacts').insert(payload);

    const { data, error } = await query.select().single();

    if (error) throw error;

    response.status(request.body.artifactId ? 200 : 201).json({ artifact: mapArtifact(data) });
  } catch (error) {
    next(error);
  }
};

export const deleteArtifact = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);

    const { error } = await db
      .from('artifacts')
      .delete()
      .eq('id', request.params.artifactId)
      .eq('owner_user_id', appUser.id);

    if (error) throw error;

    response.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const createArtifactShareLink = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);

    const { data: existing, error: existingError } = await db
      .from('artifacts')
      .select()
      .eq('id', request.params.artifactId)
      .eq('owner_user_id', appUser.id)
      .maybeSingle();

    if (existingError) throw existingError;

    if (!existing) {
      response.status(404).json({
        error: 'ARTIFACT_NOT_FOUND',
        message: 'Artifact was not found.',
      });
      return;
    }

    if (existing.share_token) {
      response.json({ artifact: mapArtifact(existing) });
      return;
    }

    const { data, error } = await db
      .from('artifacts')
      .update({
        share_token: createToken('share'),
        updated_at: new Date().toISOString(),
      })
      .eq('id', request.params.artifactId)
      .eq('owner_user_id', appUser.id)
      .select()
      .single();

    if (error) throw error;

    response.json({ artifact: mapArtifact(data) });
  } catch (error) {
    next(error);
  }
};

export const revokeArtifactShareLink = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);

    const { data, error } = await db
      .from('artifacts')
      .update({
        share_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', request.params.artifactId)
      .eq('owner_user_id', appUser.id)
      .select()
      .single();

    if (error) throw error;

    response.json({ artifact: mapArtifact(data) });
  } catch (error) {
    next(error);
  }
};

export const addProjectGrant = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    await getOwnedProject(db, request.params.projectId, appUser.id);

    const email = normalizeEmail(request.body.email);
    const access = request.body.access;

    if (!email || !validAccessLevels.has(access)) {
      response.status(400).json({
        error: 'INVALID_GRANT',
        message: 'A valid email and access level are required.',
      });
      return;
    }

    const { data, error } = await db
      .from('project_access_grants')
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

    response.status(201).json({ grant: mapGrant(data) });
  } catch (error) {
    next(error);
  }
};

export const revokeProjectGrant = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);

    const { data: grant, error: grantError } = await db
      .from('project_access_grants')
      .select('id, projects!inner(owner_user_id)')
      .eq('id', request.params.grantId)
      .eq('projects.owner_user_id', appUser.id)
      .maybeSingle();

    if (grantError) throw grantError;

    if (!grant) {
      response.status(404).json({
        error: 'GRANT_NOT_FOUND',
        message: 'Project access grant was not found.',
      });
      return;
    }

    const { error } = await db
      .from('project_access_grants')
      .delete()
      .eq('id', request.params.grantId);

    if (error) throw error;

    response.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const getSharedArtifact = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const shareToken = normalizeText(request.params.shareToken);

    const { data, error } = await db
      .from('artifacts')
      .select()
      .eq('share_token', shareToken)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      response.status(404).json({
        error: 'SHARED_ARTIFACT_NOT_FOUND',
        message: 'Shared UML file was not found.',
      });
      return;
    }

    response.json({ artifact: mapArtifact(data), access: 'view' });
  } catch (error) {
    next(error);
  }
};

export const getSharedProject = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const shareToken = normalizeText(request.params.shareToken);

    const { data: project, error: projectError } = await db
      .from('projects')
      .select()
      .eq('share_token', shareToken)
      .maybeSingle();

    if (projectError) throw projectError;

    if (!project) {
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
        .from('app_users')
        .select('id, email')
        .eq('clerk_user_id', auth.userId)
        .maybeSingle();

      if (userError) throw userError;

      if (appUser?.id === project.owner_user_id) {
        access = 'edit';
        source = 'owner';
      } else if (appUser?.email) {
        const { data: grant, error: grantError } = await db
          .from('project_access_grants')
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
      response.status(403).json({
        error: 'SHARED_PROJECT_ACCESS_DENIED',
        message: 'You do not have access to this shared project.',
      });
      return;
    }

    const { data: artifacts, error: artifactsError } = await db
      .from('artifacts')
      .select()
      .eq('project_id', project.id)
      .order('updated_at', { ascending: false });

    if (artifactsError) throw artifactsError;

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
