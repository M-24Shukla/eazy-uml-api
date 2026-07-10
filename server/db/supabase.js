import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    })
  : null;

export const requireSupabase = () => {
  if (!supabase) {
    const error = new Error('Supabase is not configured.');
    error.status = 503;
    error.code = 'SUPABASE_NOT_CONFIGURED';
    throw error;
  }

  return supabase;
};
