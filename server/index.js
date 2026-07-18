import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { clerkMiddleware } from '@clerk/express';
import { logger, requestLogger } from './logger.js';
import { requireAuth } from './middleware/requireAuth.js';
import { createRazorpayCheckout, getBillingStatus, handleRazorpayWebhook, verifyRazorpayPayment } from './routes/billing.js';
import { listPlans } from './routes/plans.js';
import { ensureUserProfile, getUserProfile, updateUserProfile } from './routes/profile.js';
import {
  addProjectGrant,
  createArtifactShareLink,
  createProject,
  deleteArtifact,
  deleteProject,
  getSharedArtifact,
  getSharedProject,
  listWorkspace,
  revokeProjectGrant,
  revokeArtifactShareLink,
  saveArtifact,
  updateProject,
} from './routes/workspace.js';

const app = express();
const port = Number(process.env.PORT || process.env.API_PORT || 8787);

const publicErrorCatalog = {
  AUTH_REQUIRED: {
    error: 'SIGN_IN_REQUIRED',
    message: 'Please sign in to continue.',
  },
  DUPLICATE_ARTIFACT_NAME: {
    error: 'DUPLICATE_NAME',
    message: 'A UML file with this name already exists in the project.',
  },
  INVALID_BILLING_TIER: {
    error: 'INVALID_PLAN',
    message: 'Please choose a valid paid plan.',
  },
  PROFILE_NOT_FOUND: {
    error: 'PROFILE_UNAVAILABLE',
    message: 'We could not load your profile yet. Please refresh and try again.',
  },
  RAZORPAY_NOT_CONFIGURED: {
    error: 'PAYMENT_UNAVAILABLE',
    message: 'Payments are not available right now. Please try again later.',
  },
  RAZORPAY_PLAN_NOT_CONFIGURED: {
    error: 'PAYMENT_UNAVAILABLE',
    message: 'This plan is not available for purchase right now.',
  },
  RAZORPAY_REQUEST_FAILED: {
    error: 'PAYMENT_UNAVAILABLE',
    message: 'We could not start payment checkout. Please try again later.',
  },
  RAZORPAY_WEBHOOK_NOT_CONFIGURED: {
    error: 'PAYMENT_UNAVAILABLE',
    message: 'Payments are not available right now. Please try again later.',
  },
  PAYMENT_ORDER_NOT_FOUND: {
    error: 'PAYMENT_NOT_FOUND',
    message: 'We could not find this payment. Please contact support if money was deducted.',
  },
  PAYMENT_VERIFICATION_FAILED: {
    error: 'PAYMENT_VERIFICATION_FAILED',
    message: 'We could not verify this payment. Please try again or contact support.',
  },
  PLAN_ACTIVATION_FAILED: {
    error: 'PLAN_ACTIVATION_PENDING',
    message: 'Payment was received, but plan activation is pending. Please contact support if it does not update shortly.',
  },
  SUPABASE_NOT_CONFIGURED: {
    error: 'WORKSPACE_UNAVAILABLE',
    message: 'Workspace service is not available right now. Please try again later.',
  },
};

const publicStatusMessages = {
  400: { error: 'BAD_REQUEST', message: 'Please check your request and try again.' },
  401: { error: 'SIGN_IN_REQUIRED', message: 'Please sign in to continue.' },
  403: { error: 'ACCESS_DENIED', message: 'You do not have access to this item.' },
  404: { error: 'NOT_FOUND', message: 'We could not find the requested item.' },
  409: { error: 'CONFLICT', message: 'This action conflicts with the current workspace state.' },
  429: { error: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' },
  503: { error: 'SERVICE_UNAVAILABLE', message: 'Service is temporarily unavailable. Please try again later.' },
};

const getPublicErrorResponse = (error, status) => {
  if (error.code && publicErrorCatalog[error.code]) {
    return publicErrorCatalog[error.code];
  }

  if (status >= 500) {
    return {
      error: 'SOMETHING_WENT_WRONG',
      message: 'Something went wrong on our side. Please try again later.',
    };
  }

  return (
    publicStatusMessages[status] || {
      error: 'REQUEST_FAILED',
      message: 'We could not complete this request. Please try again.',
    }
  );
};

app.use(requestLogger);
app.set('etag', false);
app.use('/api', (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || 'http://localhost:5173',
    credentials: true,
  }),
);
app.post(
  '/api/billing/razorpay/webhook',
  express.raw({ type: 'application/json' }),
  handleRazorpayWebhook,
);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'eazy-uml-api' });
});

app.use(clerkMiddleware());

app.get('/api/plans', listPlans);
app.post('/api/billing/checkout', requireAuth, createRazorpayCheckout);
app.post('/api/billing/verify', verifyRazorpayPayment);
app.get('/api/billing/status', requireAuth, getBillingStatus);
app.get('/api/me', requireAuth, getUserProfile);
app.post('/api/me/sync', requireAuth, ensureUserProfile);
app.patch('/api/me/profile', requireAuth, updateUserProfile);
app.get('/api/shared/artifacts/:shareToken', getSharedArtifact);
app.get('/api/shared/projects/:shareToken', getSharedProject);
app.get('/api/workspace', requireAuth, listWorkspace);
app.post('/api/projects', requireAuth, createProject);
app.patch('/api/projects/:projectId', requireAuth, updateProject);
app.delete('/api/projects/:projectId', requireAuth, deleteProject);
app.post('/api/artifacts', requireAuth, saveArtifact);
app.delete('/api/artifacts/:artifactId', requireAuth, deleteArtifact);
app.post('/api/artifacts/:artifactId/share-link', requireAuth, createArtifactShareLink);
app.delete('/api/artifacts/:artifactId/share-link', requireAuth, revokeArtifactShareLink);
app.post('/api/projects/:projectId/grants', requireAuth, addProjectGrant);
app.delete('/api/project-grants/:grantId', requireAuth, revokeProjectGrant);

app.use((error, request, response, _next) => {
  const status = error.status || 500;
  const publicError = getPublicErrorResponse(error, status);

  logger.error('request.error', {
    code: error.code || 'INTERNAL_SERVER_ERROR',
    details: error.details,
    hint: error.hint,
    message: error.message || 'Unexpected server error.',
    method: request.method,
    path: request.originalUrl,
    requestId: request.id,
    stack: error.stack,
    status,
  });

  response.status(status).json(publicError);
});

app.listen(port, () => {
  logger.info('server.start', {
    port,
    service: 'eazy-uml-api',
  });
});
