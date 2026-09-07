-- =============================================================================
-- TMF LIFT INSTALLATION AND MAINTENANCE REGISTRATION
-- Supabase SQL setup
--
-- Run this entire file once, top to bottom, in:
--   Supabase Dashboard -> SQL Editor -> New query
--
-- Safe to re-run: every statement uses IF NOT EXISTS / OR REPLACE / DROP-then-
-- CREATE for policies, so re-running this script will not duplicate objects.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Extensions
-- -----------------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- 1. Registrations table
-- -----------------------------------------------------------------------------
create table if not exists public.lift_registrations (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  qualification   text not null,
  location        text not null,
  contact_number  text not null,
  email           text not null,
  age             integer not null,
  created_at      timestamptz not null default now(),

  constraint lift_registrations_name_check
    check (
      char_length(name) between 1 and 30
      and name ~ '^[A-Za-z ]+$'
    ),

  constraint lift_registrations_qualification_check
    check (qualification in ('ITI', 'Polytechnic')),

  constraint lift_registrations_location_check
    check (location in ('Andhra Pradesh', 'Kerala', 'Others')),

  constraint lift_registrations_contact_number_check
    check (contact_number ~ '^[0-9]{10}$'),

  constraint lift_registrations_email_check
    check (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),

  constraint lift_registrations_age_check
    check (age between 1 and 100)
);

create index if not exists lift_registrations_created_at_idx
  on public.lift_registrations (created_at desc);

comment on table public.lift_registrations is
  'Public lift installation & maintenance registrations. Insert-only for anon users; select restricted to authorized admins via is_admin().';

-- -----------------------------------------------------------------------------
-- 1b. Prevent duplicate registrations
--     One entry per email, one entry per contact number. Wrapped in a DO
--     block so this file stays safe to re-run without erroring on a
--     constraint that already exists.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'lift_registrations_email_unique'
  ) then
    alter table public.lift_registrations
      add constraint lift_registrations_email_unique unique (email);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'lift_registrations_contact_number_unique'
  ) then
    alter table public.lift_registrations
      add constraint lift_registrations_contact_number_unique unique (contact_number);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Admin authorization table
--    Maps a Supabase Auth user (auth.users.id) to "is an authorized admin".
--    There is NO admin password stored anywhere in this table or in code —
--    the password lives only in Supabase Auth, which this table never sees.
-- -----------------------------------------------------------------------------
create table if not exists public.admin_users (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  created_at  timestamptz not null default now()
);

comment on table public.admin_users is
  'Allow-list of Supabase Auth user IDs who are authorized to view registrations.';

-- -----------------------------------------------------------------------------
-- 3. is_admin() helper
--    SECURITY DEFINER lets this function read admin_users on behalf of the
--    caller without needing a public SELECT policy on admin_users itself.
--    It returns true only if the currently authenticated user's auth.uid()
--    appears in admin_users.
-- -----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1 from public.admin_users where user_id = auth.uid()
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Row Level Security
-- -----------------------------------------------------------------------------
alter table public.lift_registrations enable row level security;
alter table public.admin_users        enable row level security;

-- Registrations: anon can INSERT only. No anon SELECT/UPDATE/DELETE policy
-- exists anywhere in this file, so those actions are denied by default.
drop policy if exists "anon_insert_registrations" on public.lift_registrations;
create policy "anon_insert_registrations"
  on public.lift_registrations
  for insert
  to anon
  with check (true);

-- Registrations: only authorized admins (per is_admin()) may SELECT.
drop policy if exists "admin_select_registrations" on public.lift_registrations;
create policy "admin_select_registrations"
  on public.lift_registrations
  for select
  to authenticated
  using (public.is_admin());

-- No UPDATE or DELETE policy is created for any role on lift_registrations,
-- which means updates/deletes are rejected for anon and authenticated alike.

-- admin_users: locked down completely. Nothing queries this table directly
-- from the client — is_admin() reads it via SECURITY DEFINER instead — so it
-- needs no client-facing SELECT policy. (Manage rows only from the SQL editor
-- or via the Supabase service role in a trusted server context.)

-- -----------------------------------------------------------------------------
-- 5. Make an existing Supabase Auth user an authorized admin
--
-- Step 1: Create the admin's login in Supabase Dashboard -> Authentication ->
--         Users -> Add user (email + password). Do this once per admin.
-- Step 2: Copy that user's UUID from the Users table, then run:
--
--   insert into public.admin_users (user_id, full_name)
--   values ('PASTE-USER-UUID-HERE', 'Admin Name')
--   on conflict (user_id) do nothing;
--
-- Repeat step 2 for every additional administrator.
-- -----------------------------------------------------------------------------
