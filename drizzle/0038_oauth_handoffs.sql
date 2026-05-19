-- OAuth handoff: ephemeral, single-use rendezvous between the apex GitHub
-- callback and a tenant subdomain.
--
-- This migration lands the corrected handoff model after an earlier design
-- tried to register one callback URL per tenant in the GitHub OAuth App;
-- that model is structurally infeasible because GitHub OAuth Apps allow
-- exactly one Authorization callback URL (GitHub Apps are a different
-- product). Apex completes OAuth at https://fisqua.org/auth/github/callback
-- (the one URL the OAuth App is registered with), inserts a row here keyed
-- by an opaque 256-bit random id, and 302s to
-- https://<slug>.fisqua.org/auth/github/handoff?t=<id>. The tenant subdomain
-- consumes the row atomically and creates a host-only session cookie.
--
-- Column shape:
--
--   id                — opaque 256-bit random PK; the only thing carried in
--                       the URL. Reveals nothing about the user; identity
--                       lives only in the row.
--   email             — primary verified GitHub email (lowercased) the
--                       handoff route looks up against users.email.
--   github_id         — GitHub user's numeric id as text. Bound to
--                       users.github_id on first sign-in (preserves the
--                       existing v0.4 first-login policy from
--                       app/routes/auth.github.callback.tsx).
--   github_login      — GitHub login (handle). Carried for forensic
--                       continuity; not currently consulted at consume time.
--   return_to_slug    — tenant slug captured from the apex init's state
--                       cookie. Used to construct the handoff URL and
--                       re-checked against the request host on consume
--                       (defence-in-depth — the URL slug and the row's
--                       slug must agree, else 410).
--   expires_at        — epoch-ms; rows expire 30s after creation.
--   consumed          — 0/1 flag flipped atomically on consume.
--   created_at        — epoch-ms; for housekeeping only.
--
-- No foreign keys: rows are ephemeral and the email + return_to_slug stored
-- here are re-validated on consume against a fresh users lookup and a fresh
-- getTenantFromRequest resolution. FKs would only add a delete-cascade
-- hazard during tenant suspension or user deletion without buying any
-- safety the runtime checks don't already give us.
--
-- Single-use semantics: app/lib/oauth-handoff.server.ts :: consumeHandoff
-- issues a single
--
--   UPDATE oauth_handoffs SET consumed = 1
--    WHERE id = ? AND consumed = 0 AND expires_at > ?
--    RETURNING email, github_id, return_to_slug;
--
-- D1 supports RETURNING in UPDATE. Returning a row implies consume
-- succeeded; no row implies failure (not found, expired, or already
-- consumed) and the caller emits 410.
--
-- Retention: short. The row is dead after either consume or expiry. A
-- separate housekeeping cleanup is out of scope here; volume
-- is low (one row per sign-in attempt) so even a year's accumulation is
-- a few hundred kilobytes.
--
-- Version: v0.4.0

CREATE TABLE oauth_handoffs (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  github_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  return_to_slug TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
