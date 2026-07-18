const readonlyStatuses = new Set(['expired']);

export const billingPeriodDays = Number(process.env.BILLING_PERIOD_DAYS || 30);
export const gracePeriodDays = Number(process.env.BILLING_GRACE_PERIOD_DAYS || 3);

export const toIsoFromUnix = (value) => {
  if (!value) {
    return null;
  }

  return new Date(Number(value) * 1000).toISOString();
};

export const addDays = (days, fromDate = new Date()) => {
  const nextDate = new Date(fromDate);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate.toISOString();
};

export const addBillingPeriod = (fromDate = new Date()) =>
  addDays(billingPeriodDays, fromDate);

export const addGracePeriod = (fromDate = new Date()) =>
  addDays(gracePeriodDays, fromDate);

export const isWorkspaceReadOnly = (appUser) =>
  appUser.workspace_mode === 'read_only' || readonlyStatuses.has(appUser.billing_status);

export const refreshExpiredBillingState = async (db, appUser) => {
  const now = Date.now();
  const paidPeriodEnded =
    appUser.billing_status === 'active' &&
    appUser.billing_period_ends_at &&
    new Date(appUser.billing_period_ends_at).getTime() <= now;

  if (paidPeriodEnded) {
    const graceEndsAt = addGracePeriod(new Date(appUser.billing_period_ends_at));
    const graceAlreadyEnded = new Date(graceEndsAt).getTime() <= now;
    const { data, error } = await db
      .from('eu_app_users')
      .update({
        billing_grace_ends_at: graceAlreadyEnded ? null : graceEndsAt,
        billing_status: graceAlreadyEnded ? 'expired' : 'past_due',
        tier: graceAlreadyEnded ? 'free' : appUser.tier,
        updated_at: new Date().toISOString(),
        workspace_mode: graceAlreadyEnded ? 'read_only' : 'active',
      })
      .eq('id', appUser.id)
      .select(
        'id, tier, billing_status, billing_grace_ends_at, billing_period_ends_at, workspace_mode',
      )
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  if (
    appUser.billing_status !== 'past_due' ||
    !appUser.billing_grace_ends_at ||
    new Date(appUser.billing_grace_ends_at).getTime() > now
  ) {
    return appUser;
  }

  const { data, error } = await db
    .from('eu_app_users')
    .update({
      billing_grace_ends_at: null,
      billing_status: 'expired',
      tier: 'free',
      updated_at: new Date().toISOString(),
      workspace_mode: 'read_only',
    })
    .eq('id', appUser.id)
    .select(
      'id, tier, billing_status, billing_grace_ends_at, billing_period_ends_at, workspace_mode',
    )
    .single();

  if (error) {
    throw error;
  }

  return data;
};
