/**
 * config.js
 * ---------------------------------------------------------------------------
 * Public, client-side Supabase configuration.
 *
 * SECURITY NOTE:
 * The values below (Project URL + anon/public key) are DESIGNED to be public.
 * They are safe to ship in browser JavaScript because all real protection is
 * enforced by Supabase Row Level Security (RLS) policies in the database
 * (see /sql/schema.sql), not by hiding these values.
 *
 * NEVER put any of the following in this file, or anywhere in this project:
 *   - service_role key / secret key
 *   - database password
 *   - admin email/password
 *   - JWT secret
 *
 * Replace the two placeholders below with your own project's values from:
 * Supabase Dashboard -> Project Settings -> API
 * ---------------------------------------------------------------------------
 */

const TMF_CONFIG = {
  SUPABASE_URL: "https://tvsrxwbguzbadbivmsmj.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2c3J4d2JndXpiYWRiaXZtc21qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4ODIwNTMsImV4cCI6MjEwMzQ1ODA1M30.0YXRdnxBueEzEA5xPH0ZSWOVxrLXegR3k7bPZXZKzgU",
};
