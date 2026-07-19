import { clerkClient } from '@clerk/express';
import { requireSupabase } from '../db/supabase.js';
import { logger } from '../logger.js';

const mapUserProfile = (row) => ({
  id: row.id,
  clerkUserId: row.clerk_user_id,
  email: row.email,
  displayName: row.display_name,
  avatarUrl: row.avatar_url,
  tier: row.tier,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const ensureUserProfile = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const clerkUser = await clerkClient.users.getUser(request.auth.userId);
    const email = clerkUser.primaryEmailAddress?.emailAddress;

    logger.debug('profile.sync.start', {
      clerkUserId: request.auth.userId,
      requestId: request.id,
    });

    if (!email) {
      logger.warn('profile.sync.primary_email_missing', {
        clerkUserId: request.auth.userId,
        requestId: request.id,
      });
      response.status(400).json({
        error: 'PRIMARY_EMAIL_REQUIRED',
        message: 'A verified primary email is required to create a profile.',
      });
      return;
    }

    const { data, error } = await db
      .from('eu_app_users')
      .upsert(
        {
          clerk_user_id: clerkUser.id,
          email,
          display_name: clerkUser.fullName || clerkUser.username || email,
          avatar_url: clerkUser.imageUrl || null,
          status: 'active',
        },
        { onConflict: 'clerk_user_id' },
      )
      .select()
      .single();

    if (error) {
      throw error;
    }

    logger.debug('profile.sync.success', {
      appUserId: data.id,
      clerkUserId: request.auth.userId,
      requestId: request.id,
    });

    response.json({ user: mapUserProfile(data) });
  } catch (error) {
    next(error);
  }
};

export const getUserProfile = async (request, response, next) => {
  try {
    const db = requireSupabase();

    const { data, error } = await db
      .from('eu_app_users')
      .select()
      .eq('clerk_user_id', request.auth.userId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      logger.warn('profile.get.not_found', {
        clerkUserId: request.auth.userId,
        requestId: request.id,
      });
      response.status(404).json({
        error: 'PROFILE_NOT_FOUND',
        message: 'User profile has not been synced yet.',
      });
      return;
    }

    logger.debug('profile.get.success', {
      appUserId: data.id,
      clerkUserId: request.auth.userId,
      requestId: request.id,
    });

    response.json({ user: mapUserProfile(data) });
  } catch (error) {
    next(error);
  }
};

export const updateUserProfile = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const displayName = String(request.body.displayName || '').trim();

    if (!displayName) {
      logger.warn('profile.update.invalid_display_name', {
        clerkUserId: request.auth.userId,
        requestId: request.id,
      });
      response.status(400).json({
        error: 'DISPLAY_NAME_REQUIRED',
        message: 'Display name is required.',
      });
      return;
    }

    const { data, error } = await db
      .from('eu_app_users')
      .update({ display_name: displayName })
      .eq('clerk_user_id', request.auth.userId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    logger.debug('profile.update.success', {
      appUserId: data.id,
      clerkUserId: request.auth.userId,
      requestId: request.id,
    });

    response.json({ user: mapUserProfile(data) });
  } catch (error) {
    next(error);
  }
};
