create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null unique,
  email text not null,
  display_name text not null,
  avatar_url text,
  tier text not null default 'free' check (tier in ('free', 'pro')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references app_users(id) on delete cascade,
  name text not null,
  description text,
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  public_access text check (public_access in ('view', 'edit')),
  share_token text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references app_users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
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
  on artifacts (project_id, lower(name));

create table if not exists project_access_grants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  email text not null,
  access text not null check (access in ('view', 'edit')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, email)
);

create unique index if not exists project_access_grants_email_unique
  on project_access_grants (project_id, lower(email));
