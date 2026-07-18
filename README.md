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
- `RAZORPAY_KEY_ID`: Razorpay API key id.
- `RAZORPAY_KEY_SECRET`: Razorpay API key secret.
- `RAZORPAY_WEBHOOK_SECRET`: Secret used to validate Razorpay webhook signatures.
- `BILLING_PERIOD_DAYS`: Number of days granted by one successful paid checkout. Defaults to `30`.
- `BILLING_GRACE_PERIOD_DAYS`: Grace period after paid access ends before read-only downgrade. Defaults to `3`.

## Billing Setup

Paid plans use Razorpay Orders with Standard Checkout and INR prices:

- Free: INR 0/month, 3 projects, 10 UML files, 3 share links.
- Pro: INR 99 for 30 days, 30 projects, 150 UML files, 70 share links.
- Ultra: INR 399 for 30 days, 100 projects, 1000 UML files, 500 share links.

The frontend reads prices and limits from `GET /api/plans`. Upgrade buttons call
`POST /api/billing/checkout`; the backend creates a Razorpay order and returns the public
Checkout details. The frontend opens Razorpay Checkout and sends the payment response to
`POST /api/billing/verify` for immediate signature verification. Razorpay webhooks remain
the server-side source of truth for async confirmation and retries.

Configure the Razorpay webhook URL as:

```text
https://<backend-host>/api/billing/razorpay/webhook
```

Enable these Razorpay events:

- `order.paid`
- `payment.captured`
- `payment.failed`
- optional: `payment.authorized`

Webhooks are validated with the raw request body and `X-Razorpay-Signature`; duplicate
events are deduped with `x-razorpay-event-id`.

## Current Routes

- `GET /health`
- `GET /api/plans`
- `POST /api/billing/checkout`
- `POST /api/billing/verify`
- `GET /api/billing/status`
- `POST /api/billing/razorpay/webhook`
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
