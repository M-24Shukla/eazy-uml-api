import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { clerkMiddleware } from '@clerk/express';
import { logger, requestLogger } from './logger.js';
import { requireAuth } from './middleware/requireAuth.js';
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

app.use(requestLogger);
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || 'http://localhost:5173',
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'eazy-uml-api' });
});

app.use(clerkMiddleware());

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
  logger.error('request.error', {
    code: error.code || 'INTERNAL_SERVER_ERROR',
    message: error.message || 'Unexpected server error.',
    method: request.method,
    path: request.originalUrl,
    requestId: request.id,
    status,
  });

  response.status(status).json({
    error: error.code || 'INTERNAL_SERVER_ERROR',
    message: error.message || 'Unexpected server error.',
  });
});

app.listen(port, () => {
  logger.info('server.start', {
    port,
    service: 'eazy-uml-api',
  });
});
