# eazy UML API

Backend API for eazy UML authentication, profile persistence, and future project/file persistence services.

## Run Locally

```bash
npm install
cp .env.example .env
npm run dev
```

The API starts on `http://localhost:8787` by default.

## Environment

- `CLERK_PUBLISHABLE_KEY`: Clerk publishable key required by Clerk Express middleware.
- `CLERK_SECRET_KEY`: Clerk backend secret key used to validate user sessions.
- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key for server-side persistence.
- `API_PORT`: Local API port. Defaults to `8787`.
- `ALLOWED_ORIGIN`: Frontend origin allowed by CORS. Defaults to `http://localhost:5173`.

## Current Routes

- `GET /health`
- `GET /api/me`
- `POST /api/me/sync`
- `PATCH /api/me/profile`
- `GET /api/workspace`
- `POST /api/projects`
- `PATCH /api/projects/:projectId`
- `DELETE /api/projects/:projectId`
- `POST /api/artifacts`
- `DELETE /api/artifacts/:artifactId`
- `POST /api/projects/:projectId/grants`
- `DELETE /api/project-grants/:grantId`
