import { requireSupabase } from '../db/supabase.js';
import { getPlanCatalog } from '../services/plans.js';

export const listPlans = async (_request, response, next) => {
  try {
    const db = requireSupabase();
    const plans = await getPlanCatalog(db);
    response.json({ plans });
  } catch (error) {
    next(error);
  }
};
