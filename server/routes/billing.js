import crypto from 'node:crypto';
import { clerkClient } from '@clerk/express';
import { requireSupabase } from '../db/supabase.js';
import { logger } from '../logger.js';
import { addBillingPeriod, refreshExpiredBillingState, toIsoFromUnix } from '../services/billing.js';
import { getPlanForTier } from '../services/plans.js';

const paidTiers = new Set(['pro', 'ultra']);
const successEvents = new Set(['order.paid', 'payment.captured']);
const failureEvents = new Set(['payment.failed']);

const requireRazorpayConfig = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    const error = new Error('Razorpay is not configured.');
    error.status = 503;
    error.code = 'RAZORPAY_NOT_CONFIGURED';
    throw error;
  }

  return { keyId, keySecret };
};

const getAppUser = async (db, clerkUserId) => {
  const { data, error } = await db
    .from('eu_app_users')
    .select('id, email, tier')
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

const getPlanWithBilling = async (db, tier) => {
  const plan = await getPlanForTier(db, tier);

  if (!paidTiers.has(plan.tier) || !plan.monthlyPriceInr) {
    const error = new Error('Only paid plans can be purchased.');
    error.status = 400;
    error.code = 'INVALID_BILLING_TIER';
    throw error;
  }

  return plan;
};

const razorpayPost = async (path, payload) => {
  const { keyId, keySecret } = requireRazorpayConfig();
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      body.error?.description || body.error?.reason || 'Razorpay request failed.',
    );
    error.status = response.status;
    error.code = body.error?.code || 'RAZORPAY_REQUEST_FAILED';
    throw error;
  }

  return body;
};

const resolvePublicOrderStatus = (record) => {
  const createdAt = record.created_at ? new Date(record.created_at).getTime() : 0;
  const isStaleCreatedOrder =
    record.status === 'created' && createdAt && Date.now() - createdAt > 10 * 60 * 1000;

  return isStaleCreatedOrder ? 'pending_confirmation' : record.status;
};

const mapBillingRecord = (record) => {
  if (!record) {
    return null;
  }

  return {
    cancelAtPeriodEnd: false,
    currentPeriodEnd: record.current_period_end,
    currentPeriodStart: record.current_period_start,
    graceEndsAt: null,
    provider: record.provider,
    status: resolvePublicOrderStatus(record),
    tier: record.tier,
  };
};

const mapPurchaseHistoryItem = (record) => ({
  amountInr: record.amount_inr,
  createdAt: record.created_at,
  currentPeriodEnd: record.current_period_end,
  currentPeriodStart: record.current_period_start,
  id: record.id,
  orderId: record.provider_order_id,
  paymentId: record.provider_payment_id,
  provider: record.provider,
  status: resolvePublicOrderStatus(record),
  tier: record.tier,
  updatedAt: record.updated_at,
});

const getOrderFromPayload = (payload) => payload.payload?.order?.entity;
const getPaymentFromPayload = (payload) => payload.payload?.payment?.entity;

const verifyWebhookSignature = (rawBody, signature) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    const error = new Error('Razorpay webhook secret is not configured.');
    error.status = 503;
    error.code = 'RAZORPAY_WEBHOOK_NOT_CONFIGURED';
    throw error;
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(String(signature || ''));

  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
};

const verifyCheckoutSignature = ({ orderId, paymentId, signature }) => {
  const { keySecret } = requireRazorpayConfig();
  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(String(signature || ''));

  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
};

const findBillingOrder = async (db, providerOrderId) => {
  const { data, error } = await db
    .from('eu_payment_orders')
    .select('id, app_user_id, provider_order_id, tier, amount_inr, status')
    .eq('provider', 'razorpay')
    .eq('provider_order_id', providerOrderId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
};

const activatePaidOrder = async (db, billingOrder, payment, rawPayload) => {
  if (!billingOrder || !paidTiers.has(billingOrder.tier)) {
    return null;
  }

  const now = new Date();
  const currentPeriodStart = now.toISOString();
  const currentPeriodEnd = addBillingPeriod(now);
  const providerPaymentId = payment?.id || null;

  const { data: updatedOrder, error: orderError } = await db
    .from('eu_payment_orders')
    .update({
      current_period_end: currentPeriodEnd,
      current_period_start: currentPeriodStart,
      provider_payment_id: providerPaymentId,
      raw_payload: rawPayload,
      status: 'paid',
      updated_at: new Date().toISOString(),
    })
    .eq('id', billingOrder.id)
    .select(
      'app_user_id, provider, status, tier, current_period_start, current_period_end, updated_at',
    )
    .single();

  if (orderError) {
    throw orderError;
  }

  const { error: userError } = await db
    .from('eu_app_users')
    .update({
      billing_grace_ends_at: null,
      billing_period_ends_at: currentPeriodEnd,
      billing_status: 'active',
      tier: billingOrder.tier,
      updated_at: new Date().toISOString(),
      workspace_mode: 'active',
    })
    .eq('id', billingOrder.app_user_id);

  if (userError) {
    userError.status = 500;
    userError.code = 'PLAN_ACTIVATION_FAILED';
    throw userError;
  }

  return updatedOrder;
};

const markOrderFailed = async (db, providerOrderId, payment, rawPayload) => {
  const { error } = await db
    .from('eu_payment_orders')
    .update({
      provider_payment_id: payment?.id || null,
      raw_payload: rawPayload,
      status: 'failed',
      updated_at: new Date().toISOString(),
    })
    .eq('provider', 'razorpay')
    .eq('provider_order_id', providerOrderId);

  if (error) {
    throw error;
  }
};

export const getBillingStatus = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const { data: appUser, error: userError } = await db
      .from('eu_app_users')
      .select(
        'id, tier, billing_status, billing_grace_ends_at, billing_period_ends_at, workspace_mode',
      )
      .eq('clerk_user_id', request.auth.userId)
      .maybeSingle();

    if (userError) {
      throw userError;
    }

    if (!appUser) {
      const notFound = new Error('User profile has not been synced yet.');
      notFound.status = 404;
      notFound.code = 'PROFILE_NOT_FOUND';
      throw notFound;
    }

    const refreshedUser = await refreshExpiredBillingState(db, appUser);
    const { data: orders, error: orderError } = await db
      .from('eu_payment_orders')
      .select(
        'amount_inr, created_at, current_period_end, current_period_start, id, provider, provider_order_id, provider_payment_id, status, tier, updated_at',
      )
      .eq('app_user_id', appUser.id)
      .order('updated_at', { ascending: false })
      .limit(10);

    if (orderError) {
      throw orderError;
    }

    response.json({
      billingRecord: mapBillingRecord(orders?.[0]),
      purchaseHistory: orders?.map(mapPurchaseHistoryItem) ?? [],
      user: {
        billingStatus: refreshedUser.billing_status,
        currentPeriodEnd: refreshedUser.billing_period_ends_at,
        graceEndsAt: refreshedUser.billing_grace_ends_at,
        tier: refreshedUser.tier,
        workspaceMode: refreshedUser.workspace_mode,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const createRazorpayCheckout = async (request, response, next) => {
  try {
    const db = requireSupabase();
    const appUser = await getAppUser(db, request.auth.userId);
    const tier = String(request.body.tier || '').toLowerCase();
    const plan = await getPlanWithBilling(db, tier);
    const clerkUser = await clerkClient.users.getUser(request.auth.userId);
    const email =
      clerkUser.primaryEmailAddress?.emailAddress ??
      clerkUser.emailAddresses?.[0]?.emailAddress ??
      appUser.email;
    const amount = plan.monthlyPriceInr * 100;
    const receipt = `eu_${plan.tier}_${Date.now()}`.slice(0, 40);

    const order = await razorpayPost('/orders', {
      amount,
      currency: 'INR',
      notes: {
        app_user_id: appUser.id,
        clerk_user_id: request.auth.userId,
        product: 'eazy-uml',
        tier: plan.tier,
      },
      receipt,
    });

    const { error } = await db.from('eu_payment_orders').upsert(
      {
        amount_inr: plan.monthlyPriceInr,
        app_user_id: appUser.id,
        currency: 'INR',
        provider: 'razorpay',
        provider_order_id: order.id,
        raw_payload: order,
        receipt,
        status: order.status || 'created',
        tier: plan.tier,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'provider,provider_order_id' },
    );

    if (error) {
      throw error;
    }

    logger.info('billing.checkout.created', {
      amountInr: plan.monthlyPriceInr,
      planTier: plan.tier,
      provider: 'razorpay',
      providerOrderId: order.id,
      requestId: request.id,
      userId: appUser.id,
    });

    const { keyId } = requireRazorpayConfig();
    response.status(201).json({
      amount,
      currency: 'INR',
      description: `${plan.label} plan - 30 days`,
      keyId,
      name: 'Eazy UML',
      orderId: order.id,
      prefill: {
        email,
        name: clerkUser.fullName || clerkUser.username || appUser.email,
      },
      provider: 'razorpay',
      tier: plan.tier,
    });
  } catch (error) {
    next(error);
  }
};

export const verifyRazorpayPayment = async (request, response, next) => {
  try {
    const orderId = String(request.body.razorpay_order_id || '');
    const paymentId = String(request.body.razorpay_payment_id || '');
    const signature = String(request.body.razorpay_signature || '');

    if (!orderId || !paymentId || !signature) {
      const error = new Error('Payment verification details are missing.');
      error.status = 400;
      error.code = 'PAYMENT_VERIFICATION_FAILED';
      throw error;
    }

    if (!verifyCheckoutSignature({ orderId, paymentId, signature })) {
      const error = new Error('Payment signature verification failed.');
      error.status = 400;
      error.code = 'PAYMENT_VERIFICATION_FAILED';
      throw error;
    }

    const db = requireSupabase();
    const billingOrder = await findBillingOrder(db, orderId);
    if (!billingOrder) {
      const error = new Error('Payment order was not found.');
      error.status = 404;
      error.code = 'PAYMENT_ORDER_NOT_FOUND';
      throw error;
    }

    const updatedOrder = await activatePaidOrder(
      db,
      billingOrder,
      { id: paymentId },
      { source: 'checkout.verify', orderId, paymentId },
    );

    logger.info('billing.checkout.verified', {
      appUserId: billingOrder.app_user_id,
      provider: 'razorpay',
      providerOrderId: orderId,
      providerPaymentId: paymentId,
      requestId: request.id,
      tier: billingOrder.tier,
    });

    response.json({
      ok: true,
      billingRecord: mapBillingRecord(updatedOrder),
    });
  } catch (error) {
    next(error);
  }
};

export const handleRazorpayWebhook = async (request, response, next) => {
  try {
    const rawBody = request.body;
    const signature = request.headers['x-razorpay-signature'];
    const eventId = request.headers['x-razorpay-event-id'];

    if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature(rawBody, signature)) {
      logger.warn('billing.webhook.invalid_signature', {
        provider: 'razorpay',
        requestId: request.id,
      });
      response.status(400).json({ ok: false });
      return;
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const providerEventId = String(eventId || payload.event_id || crypto.randomUUID());
    const db = requireSupabase();

    const { error: eventInsertError } = await db.from('eu_payment_events').insert({
      event_type: payload.event || 'unknown',
      payload,
      provider: 'razorpay',
      provider_event_id: providerEventId,
    });

    if (eventInsertError) {
      if (eventInsertError.code === '23505') {
        logger.info('billing.webhook.duplicate_reprocessing', {
          eventId: providerEventId,
          provider: 'razorpay',
          requestId: request.id,
        });
      } else {
        throw eventInsertError;
      }
    }

    const order = getOrderFromPayload(payload);
    const payment = getPaymentFromPayload(payload);
    const providerOrderId = order?.id || payment?.order_id;

    if (!providerOrderId) {
      logger.info('billing.webhook.ignored', {
        event: payload.event,
        eventId: providerEventId,
        provider: 'razorpay',
        requestId: request.id,
      });
      response.json({ ok: true, ignored: true });
      return;
    }

    const billingOrder = await findBillingOrder(db, providerOrderId);
    if (!billingOrder) {
      logger.warn('billing.webhook.unmatched_order', {
        event: payload.event,
        eventId: providerEventId,
        providerOrderId,
        requestId: request.id,
      });
      response.json({ ok: true, ignored: true });
      return;
    }

    if (successEvents.has(payload.event)) {
      await activatePaidOrder(db, billingOrder, payment, payload);
    } else if (failureEvents.has(payload.event)) {
      await markOrderFailed(db, providerOrderId, payment, payload);
    } else {
      logger.info('billing.webhook.ignored_event', {
        event: payload.event,
        eventId: providerEventId,
        providerOrderId,
        requestId: request.id,
      });
      response.json({ ok: true, ignored: true });
      return;
    }

    logger.info('billing.webhook.processed', {
      appUserId: billingOrder.app_user_id,
      event: payload.event,
      eventId: providerEventId,
      provider: 'razorpay',
      providerOrderId,
      status: successEvents.has(payload.event) ? 'paid' : 'failed',
    });

    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
};
