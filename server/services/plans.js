import { logger } from '../logger.js';

export const fallbackPlanCatalog = [
  {
    tier: 'free',
    label: 'Free',
    maxProjects: 3,
    maxArtifacts: 10,
    maxShareLinks: 3,
    monthlyPriceInr: 0,
    billingInterval: 'month',
    razorpayPlanId: null,
    sortOrder: 10,
  },
  {
    tier: 'pro',
    label: 'Pro',
    maxProjects: 30,
    maxArtifacts: 150,
    maxShareLinks: 70,
    monthlyPriceInr: 99,
    billingInterval: 'month',
    razorpayPlanId: null,
    sortOrder: 20,
  },
  {
    tier: 'ultra',
    label: 'Ultra',
    maxProjects: 100,
    maxArtifacts: 1000,
    maxShareLinks: 500,
    monthlyPriceInr: 399,
    billingInterval: 'month',
    razorpayPlanId: null,
    sortOrder: 30,
  },
];

const cacheTtlMs = Number(process.env.PLAN_CACHE_TTL_MS || 300000);

let cachedPlans = null;
let cachedAt = 0;

const mapPlan = (row) => ({
  tier: row.tier,
  label: row.label,
  maxProjects: row.max_projects,
  maxArtifacts: row.max_artifacts,
  maxShareLinks: row.max_share_links,
  monthlyPriceInr: row.monthly_price_inr ?? 0,
  billingInterval: row.billing_interval ?? 'month',
  razorpayPlanId: row.razorpay_plan_id ?? null,
});

export const getPlanCatalog = async (db) => {
  const now = Date.now();
  if (cachedPlans && now - cachedAt < cacheTtlMs) {
    return cachedPlans;
  }

  const { data, error } = await db
    .from('eu_plan_catalog')
    .select()
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error) {
    logger.warn('plans.catalog.fallback', {
      message: error.message,
    });
    cachedPlans = fallbackPlanCatalog;
  } else {
    cachedPlans = data.map(mapPlan);
  }

  cachedAt = now;
  return cachedPlans;
};

export const getPlanForTier = async (db, tier) => {
  const plans = await getPlanCatalog(db);
  return (
    plans.find((plan) => plan.tier === tier) ??
    plans.find((plan) => plan.tier === 'free') ??
    fallbackPlanCatalog[0]
  );
};

export const clearPlanCache = () => {
  cachedPlans = null;
  cachedAt = 0;
};
