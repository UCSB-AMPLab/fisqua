-- Tenants foundation: tenant identity, capability matrix, quota fields, seed data
--
-- This migration introduces multi-tenancy by laying the tenants table that
-- every domain row will reference (lands in 0035). The table carries an opaque
-- v4 UUID primary key, a routable lowercase-kebab slug, a name, and three
-- enumerated status columns whose constraints gate operator privilege and
-- standard-aware validation downstream.
--
-- The CHECK constraints are deliberate. Without them, any path that
-- writes a tenant row (raw SQL, future bulk import, a buggy admin
-- endpoint) could produce a "tenant without a standard" or a "kind
-- that is neither tenant nor platform", silently breaking the operator
-- gate and the validator-selection layer. The constraints are:
--
--   1. kind IN ('tenant','platform')     -- the operator-privilege boundary
--   2. status IN ('active','suspended')  -- the soft-disable boundary
--   3. descriptive_standard conditional  -- NULL only when kind='platform';
--                                          one of isadg/dacs/rad when 'tenant'
--   4. slug GLOB                         -- lowercase-kebab subdomain shape;
--                                          reserved-slug list lives in app code
--
-- Capability flags (4 booleans): crowdsourcing default false,
-- vocabulary_hub default true, publish_pipeline default true,
-- multi_repository default false. Operator-set at provisioning,
-- effectively immutable.
--
-- Seed: two rows. The reserved `platform` tenant (kind='platform',
-- descriptive_standard NULL, all capabilities OFF, the operator gate's
-- target) and the initial `neogranadina` tenant (kind='tenant',
-- descriptive_standard='isadg', all capabilities ON because Neogranadina
-- has all four enabled). The two UUIDs MUST match byte-for-byte the
-- values in app/lib/tenant.ts and the back-fill literals in 0035.
--
-- Version: v0.4.0

CREATE TABLE tenants (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'tenant' CHECK (kind IN ('tenant','platform')),
  descriptive_standard TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  crowdsourcing_enabled    INTEGER NOT NULL DEFAULT 0,
  vocabulary_hub_enabled   INTEGER NOT NULL DEFAULT 1,
  publish_pipeline_enabled INTEGER NOT NULL DEFAULT 1,
  multi_repository_enabled INTEGER NOT NULL DEFAULT 0,
  quota_storage_bytes INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- SQLite CHECK constraints pass on NULL (a CHECK only rejects when
  -- the expression evaluates to FALSE, not NULL), so the second
  -- branch must explicitly require descriptive_standard IS NOT NULL.
  -- Without that guard, `kind='tenant', descriptive_standard=NULL`
  -- would slip through because `NULL IN (...)` evaluates to NULL,
  -- making the OR-clause NULL (not FALSE) and the CHECK pass.
  CHECK (
    (kind = 'platform' AND descriptive_standard IS NULL)
    OR
    (kind = 'tenant'   AND descriptive_standard IS NOT NULL AND descriptive_standard IN ('isadg','dacs','rad'))
  ),
  CHECK (slug GLOB '[a-z][a-z0-9-]*[a-z0-9]' OR slug GLOB '[a-z]')
);

CREATE UNIQUE INDEX tenants_slug_idx ON tenants(slug);
CREATE INDEX tenants_kind_idx ON tenants(kind);

-- Seed: platform (operator gate target) + neogranadina (initial tenant).
-- UUID literals MUST match app/lib/tenant.ts byte-for-byte.

INSERT INTO tenants (
  id, slug, name, kind, descriptive_standard, status,
  crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled,
  quota_storage_bytes, created_at, updated_at
) VALUES (
  '0391baa2-0bab-44ae-ac08-9fa7eb7c6145', 'platform',     'Platform',     'platform', NULL,    'active',
  0, 0, 0, 0,
  NULL, 1778100000000, 1778100000000
);

INSERT INTO tenants (
  id, slug, name, kind, descriptive_standard, status,
  crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled,
  quota_storage_bytes, created_at, updated_at
) VALUES (
  'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', 'neogranadina', 'Neogranadina', 'tenant',   'isadg', 'active',
  1, 1, 1, 1,
  NULL, 1778100000000, 1778100000000
);
