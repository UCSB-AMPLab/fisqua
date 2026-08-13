#!/usr/bin/env npx tsx
/**
 * Claim Authorities
 *
 * This script writes out the SQL that hands a federation's entity and
 * place records over to one of its tenants — an OWNERSHIP STAMP, and
 * nothing else. It prints that SQL to the terminal (or to a file) and
 * stops. It opens no database connection, runs no wrangler command, and
 * cannot touch production even by accident: whoever reviews the output
 * is the one who decides to run it, against which environment, and when.
 *
 * WHY A SCRIPT AND NOT A MIGRATION
 * --------------------------------
 * Migration 0067 adds the `tenant_id` column to `entities` and `places`
 * and deliberately leaves every existing row NULL — federation-shared,
 * exactly as it was. That keeps the schema change harmless: nothing
 * behaves differently the moment it lands. Deciding that a particular
 * set of records now belongs to a particular tenant is a different kind
 * of decision, one that depends on facts about the institution rather
 * than about the schema, and it should be read by a person before it
 * runs. So the claim is a reviewed data step, separate from the schema
 * step, and this script produces the artefact to review.
 *
 * WHAT THE SQL DOES
 * -----------------
 * Three parts, in order:
 *
 *   1. A BEFORE count: how many entities and places live in the
 *      federation, split by their current owner. Run it first; if the
 *      numbers do not match what was expected, stop.
 *   2. Two UPDATEs, one per table, stamping the tenant id onto every row
 *      of the federation (optionally narrowed further — see below).
 *      Idempotent: the WHERE clauses skip rows already stamped, so a
 *      re-run changes nothing.
 *   3. An AFTER count in the same shape as the before, plus an integrity
 *      check that no row ended up owned by a tenant outside the
 *      federation.
 *
 * Junction rows (`description_entities`, `description_places`) are NOT
 * touched. They key off the authority record's `id`, which the claim
 * does not change, so every existing link keeps working across the
 * stamp. This is ownership, not re-linking.
 *
 * NARROWING, AND WHEN IT IS WORTH IT
 * ----------------------------------
 * By default the claim covers the whole federation, which is right when
 * the federation's authority space belongs entirely to the tenant being
 * given it. `--created-at <epoch-ms>` adds a second condition on the
 * seed timestamp, so the claim covers only rows stamped by one seeding
 * run. Use it as belt and braces when a federation's authority space is
 * known to be one import and the count should prove it.
 *
 * Usage:
 *   npx tsx scripts/claim-authorities.ts --federation <alias|uuid> --tenant <alias|uuid>
 *   npx tsx scripts/claim-authorities.ts --federation ampl --tenant sbmal --created-at 1786857600000
 *   npx tsx scripts/claim-authorities.ts --federation ampl --tenant sbmal --out claim.sql
 *
 * Aliases resolve against the locked identity constants in
 * `app/lib/tenant.ts`, so a typo becomes an error rather than a UUID
 * that quietly matches nothing. Raw UUIDs are accepted for federations
 * and tenants provisioned after those constants were written.
 *
 * The script REFUSES to emit a claim whose tenant is not a member of the
 * named federation when both are known aliases — that pairing would
 * violate the invariant the column carries (an owned row's federation
 * must be its owner's federation), and no amount of review should have
 * to catch it.
 *
 * @version v0.7.0
 */

import {
  AMPL_FEDERATION_ID,
  AHR_TENANT_ID,
  KOMUNI_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
  NEOGRANADINA_TENANT_ID,
  SBMAL_TENANT_ID,
} from "../app/lib/tenant";

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/** Federation aliases accepted on the command line. */
const FEDERATIONS: Record<string, string> = {
  ampl: AMPL_FEDERATION_ID,
  neogranadina: NEOGRANADINA_FEDERATION_ID,
};

/**
 * Tenant aliases, each mapped to the federation it belongs to, so the
 * script can refuse a cross-federation claim before printing anything.
 */
const TENANTS: Record<string, { id: string; federationId: string }> = {
  sbmal: { id: SBMAL_TENANT_ID, federationId: AMPL_FEDERATION_ID },
  neogranadina: {
    id: NEOGRANADINA_TENANT_ID,
    federationId: NEOGRANADINA_FEDERATION_ID,
  },
  ahr: { id: AHR_TENANT_ID, federationId: NEOGRANADINA_FEDERATION_ID },
  komuni: { id: KOMUNI_TENANT_ID, federationId: NEOGRANADINA_FEDERATION_ID },
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  federationId: string;
  tenantId: string;
  createdAt: number | null;
  out: string | null;
}

function fail(message: string): never {
  console.error(`claim-authorities: ${message}`);
  process.exit(1);
}

function valueFor(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value`);
  return v;
}

function parseArgs(argv: string[]): Options {
  const federationArg = valueFor(argv, "--federation");
  const tenantArg = valueFor(argv, "--tenant");
  if (!federationArg || !tenantArg) {
    fail(
      "usage: claim-authorities.ts --federation <alias|uuid> --tenant <alias|uuid> " +
        "[--created-at <epoch-ms>] [--out <file>]",
    );
  }

  const federationId = FEDERATIONS[federationArg] ?? federationArg;
  if (!UUID_RE.test(federationId)) {
    fail(
      `unknown federation ${JSON.stringify(federationArg)} — use one of ` +
        `${Object.keys(FEDERATIONS).join(", ")} or a UUID`,
    );
  }

  const known = TENANTS[tenantArg];
  const tenantId = known?.id ?? tenantArg;
  if (!UUID_RE.test(tenantId)) {
    fail(
      `unknown tenant ${JSON.stringify(tenantArg)} — use one of ` +
        `${Object.keys(TENANTS).join(", ")} or a UUID`,
    );
  }

  // The invariant the column carries: an owned row's federation is its
  // owner's federation. Refuse the pairing outright when both sides are
  // known, rather than emitting SQL that would break it.
  if (known && known.federationId !== federationId) {
    fail(
      `tenant ${tenantArg} belongs to federation ${known.federationId}, not ` +
        `${federationId} — ownership narrows scope, it never moves a record ` +
        "between federations",
    );
  }

  const createdAtArg = valueFor(argv, "--created-at");
  let createdAt: number | null = null;
  if (createdAtArg !== null) {
    createdAt = Number(createdAtArg);
    if (!Number.isInteger(createdAt) || createdAt <= 0) {
      fail(`--created-at must be a positive integer of epoch milliseconds`);
    }
  }

  return { federationId, tenantId, createdAt, out: valueFor(argv, "--out") };
}

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildSql(opts: Options): string {
  const fed = quote(opts.federationId);
  const ten = quote(opts.tenantId);
  const seedArm =
    opts.createdAt === null ? "" : `\n    AND created_at = ${opts.createdAt}`;
  const seedNote =
    opts.createdAt === null
      ? "every entity and place"
      : `the entities and places seeded at created_at = ${opts.createdAt}`;

  return `-- Authority ownership claim
--
-- Stamps tenant ${opts.tenantId}
-- onto ${seedNote} in federation
-- ${opts.federationId}.
--
-- Generated by scripts/claim-authorities.ts. REVIEW BEFORE RUNNING.
-- This file was written, not executed: nothing has changed yet.
--
-- Run part 1 first and read the numbers. Only then run part 2. Part 3
-- confirms the result and must report zero cross-federation rows.
--
-- Junction rows (description_entities, description_places) are NOT
-- touched — they key off the authority record's id, which does not
-- change here, so every existing link survives the claim.

-- --------------------------------------------------------------------
-- Part 1 — before
-- --------------------------------------------------------------------

SELECT 'entities' AS table_name,
       COUNT(*) AS total,
       SUM(CASE WHEN tenant_id IS NULL THEN 1 ELSE 0 END) AS shared,
       SUM(CASE WHEN tenant_id = ${ten} THEN 1 ELSE 0 END) AS already_claimed,
       SUM(CASE WHEN tenant_id IS NOT NULL AND tenant_id <> ${ten} THEN 1 ELSE 0 END) AS owned_by_others
  FROM entities
 WHERE federation_id = ${fed};

SELECT 'places' AS table_name,
       COUNT(*) AS total,
       SUM(CASE WHEN tenant_id IS NULL THEN 1 ELSE 0 END) AS shared,
       SUM(CASE WHEN tenant_id = ${ten} THEN 1 ELSE 0 END) AS already_claimed,
       SUM(CASE WHEN tenant_id IS NOT NULL AND tenant_id <> ${ten} THEN 1 ELSE 0 END) AS owned_by_others
  FROM places
 WHERE federation_id = ${fed};

-- --------------------------------------------------------------------
-- Part 2 — the claim
--
-- Idempotent: \`tenant_id IS NULL\` skips rows already stamped, so a
-- re-run is a no-op. Rows already owned by ANOTHER tenant are left
-- alone rather than reassigned — if part 1 reported any, stop and work
-- out why before continuing.
-- --------------------------------------------------------------------

UPDATE entities
   SET tenant_id = ${ten}
 WHERE federation_id = ${fed}
   AND tenant_id IS NULL${seedArm};

UPDATE places
   SET tenant_id = ${ten}
 WHERE federation_id = ${fed}
   AND tenant_id IS NULL${seedArm};

-- --------------------------------------------------------------------
-- Part 3 — after
--
-- The two counts should mirror part 1 with \`shared\` drained into
-- \`already_claimed\`. The integrity check MUST return no rows: an owned
-- record's federation must equal its owner's federation.
-- --------------------------------------------------------------------

SELECT 'entities' AS table_name,
       COUNT(*) AS total,
       SUM(CASE WHEN tenant_id IS NULL THEN 1 ELSE 0 END) AS shared,
       SUM(CASE WHEN tenant_id = ${ten} THEN 1 ELSE 0 END) AS already_claimed,
       SUM(CASE WHEN tenant_id IS NOT NULL AND tenant_id <> ${ten} THEN 1 ELSE 0 END) AS owned_by_others
  FROM entities
 WHERE federation_id = ${fed};

SELECT 'places' AS table_name,
       COUNT(*) AS total,
       SUM(CASE WHEN tenant_id IS NULL THEN 1 ELSE 0 END) AS shared,
       SUM(CASE WHEN tenant_id = ${ten} THEN 1 ELSE 0 END) AS already_claimed,
       SUM(CASE WHEN tenant_id IS NOT NULL AND tenant_id <> ${ten} THEN 1 ELSE 0 END) AS owned_by_others
  FROM places
 WHERE federation_id = ${fed};

SELECT 'entities' AS table_name, a.id, a.federation_id, a.tenant_id
  FROM entities a
  JOIN tenants t ON t.id = a.tenant_id
 WHERE t.federation_id <> a.federation_id
 UNION ALL
SELECT 'places' AS table_name, p.id, p.federation_id, p.tenant_id
  FROM places p
  JOIN tenants t ON t.id = p.tenant_id
 WHERE t.federation_id <> p.federation_id;
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const sql = buildSql(opts);

  if (opts.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(opts.out, sql, "utf-8");
    console.error(`claim-authorities: wrote ${opts.out} — review before running`);
    return;
  }
  process.stdout.write(sql);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void main();
}

export { buildSql, parseArgs };
