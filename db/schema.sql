create extension if not exists pgcrypto;

create table if not exists eu_app_users (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null unique,
  email text not null,
  display_name text not null,
  avatar_url text,
  tier text not null default 'free' check (tier in ('free', 'pro', 'ultra')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  alter table eu_app_users drop constraint if exists app_users_tier_check;
  alter table eu_app_users drop constraint if exists eu_app_users_tier_check;
  alter table eu_app_users add constraint eu_app_users_tier_check check (tier in ('free', 'pro', 'ultra'));
end $$;

create table if not exists eu_plan_catalog (
  tier text primary key check (tier in ('free', 'pro', 'ultra')),
  label text not null,
  max_projects integer not null check (max_projects >= 0),
  max_artifacts integer not null check (max_artifacts >= 0),
  max_share_links integer not null check (max_share_links >= 0),
  monthly_price_inr integer not null default 0 check (monthly_price_inr >= 0),
  billing_interval text not null default 'month' check (billing_interval in ('month')),
  razorpay_plan_id text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table eu_plan_catalog add column if not exists monthly_price_inr integer not null default 0;
alter table eu_plan_catalog add column if not exists billing_interval text not null default 'month';
alter table eu_plan_catalog add column if not exists razorpay_plan_id text;

insert into eu_plan_catalog (
  tier,
  label,
  max_projects,
  max_artifacts,
  max_share_links,
  monthly_price_inr,
  billing_interval,
  sort_order
) values
  ('free', 'Free', 3, 10, 3, 0, 'month', 10),
  ('pro', 'Pro', 30, 150, 70, 99, 'month', 20),
  ('ultra', 'Ultra', 100, 1000, 500, 399, 'month', 30)
on conflict (tier) do update set
  label = excluded.label,
  max_projects = excluded.max_projects,
  max_artifacts = excluded.max_artifacts,
  max_share_links = excluded.max_share_links,
  monthly_price_inr = excluded.monthly_price_inr,
  billing_interval = excluded.billing_interval,
  sort_order = excluded.sort_order,
  updated_at = now();

alter table eu_app_users add column if not exists billing_status text not null default 'free';
alter table eu_app_users add column if not exists billing_grace_ends_at timestamptz;
alter table eu_app_users add column if not exists billing_period_ends_at timestamptz;
alter table eu_app_users add column if not exists workspace_mode text not null default 'active';

create table if not exists eu_payment_orders (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references eu_app_users(id) on delete cascade,
  provider text not null check (provider in ('razorpay')),
  provider_order_id text not null,
  provider_payment_id text,
  receipt text,
  tier text not null check (tier in ('pro', 'ultra')),
  amount_inr integer not null check (amount_inr >= 0),
  currency text not null default 'INR',
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_order_id)
);

create table if not exists eu_payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('razorpay')),
  provider_event_id text not null,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create table if not exists eu_projects (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references eu_app_users(id) on delete cascade,
  name text not null,
  description text,
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  public_access text check (public_access in ('view', 'edit')),
  share_token text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists eu_artifacts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references eu_app_users(id) on delete cascade,
  project_id uuid not null references eu_projects(id) on delete cascade,
  name text not null,
  type text not null check (
    type in ('sequence-diagram', 'class-diagram', 'activity-diagram', 'state-machine-diagram')
  ),
  content text not null,
  share_token text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists artifacts_project_name_unique
  on eu_artifacts (project_id, lower(name));

create table if not exists eu_project_access_grants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references eu_projects(id) on delete cascade,
  email text not null,
  access text not null check (access in ('view', 'edit')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, email)
);

create unique index if not exists project_access_grants_email_unique
  on eu_project_access_grants (project_id, lower(email));
