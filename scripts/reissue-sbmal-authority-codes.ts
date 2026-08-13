#!/usr/bin/env npx tsx
/**
 * Reissue SBMAL Authority Codes
 *
 * This script writes out the SQL that re-marks the roughly 500 entity
 * and place codes in the AMPL federation from Neogranadina's series
 * (`ne-xxxxxx`, `nl-xxxxxx`) to SBMAL's own (`sbmal-e-xxxxxx`,
 * `sbmal-p-xxxxxx`). It prints that SQL to the terminal (or to a file)
 * and stops. Like `claim-authorities.ts`, it opens no database
 * connection, runs no wrangler command, and cannot touch production even
 * by accident: whoever reads the output decides whether to run it,
 * against which environment, and when.
 *
 * WHY THESE CODES ARE WRONG
 * -------------------------
 * A code's prefix names the agency that MAINTAINS the record — whoever
 * did the identifying, extracting and enriching that produced it. `ne`
 * and `nl` are short for "neogranadina entidad" and "neogranadina
 * lugar". Until migration 0068 they were hardcoded in the generator, so
 * the Santa Barbara Mission Archive-Library — a Franciscan mission
 * archive in California, whose material has nothing to do with
 * Neogranadina — has been minting codes that assert its people and
 * places are Neogranadina's work. 0068 fixes the minting; these 500
 * already-minted rows are the residue.
 *
 * WHY REISSUING IS ACCEPTABLE HERE AND NOWHERE ELSE
 * -------------------------------------------------
 * An authority code is a citable scholarly identifier, in the manner of
 * a Medici Archive Project number. Reissuing one is normally
 * unthinkable: it breaks every citation of the record, and there is no
 * way to know who holds them. These particular codes are the one case
 * where nothing breaks, because nothing has been built on them yet:
 *
 *   - they were minted on 2026-08-12, the same day the defect was found;
 *   - they have never been published, exported, or cited;
 *   - they appear in no URL — every route keys on the record's UUID.
 *
 * So there is no citation to invalidate and no link to rot, and the
 * choice is between 500 rows carrying a false agency mark permanently
 * and one reviewed UPDATE now.
 *
 * THIS SCRIPT MUST NEVER BE GENERALISED INTO A ROUTINE RE-CODING TOOL.
 * It is deliberately hardcoded to one federation and one pair of
 * prefixes, takes no arguments that would let it be pointed elsewhere,
 * and should be deleted once it has been run. A general re-coding
 * command would make code reissue look like ordinary maintenance, and
 * the next set of codes to be reissued will not be unpublished — the
 * next one will be somebody's footnote. Ownership can be transferred
 * (`entities.tenant_id`, migration 0067); the agency mark on a published
 * code cannot.
 *
 * WHAT THE SQL DOES
 * -----------------
 * Four parts, in order:
 *
 *   1. A BEFORE count per table: how many rows carry the Neogranadina
 *      prefix, how many already carry SBMAL's, how many carry something
 *      else, and how they break down by owning tenant. Run it first; if
 *      the numbers are not what was expected, stop.
 *   2. Two pre-checks that MUST both return zero:
 *      - malformed sources: a row whose code starts with the old prefix
 *        but is not exactly prefix + six characters, which the rewrite
 *        would mangle;
 *      - collisions: a row whose rewritten code already exists in the
 *        federation. Codes are UNIQUE per (federation_id, code), so a
 *        collision would abort the UPDATE halfway.
 *   3. Two UPDATEs, one per table, rewriting only the prefix and keeping
 *      the six characters — `ne-abc234` becomes `sbmal-e-abc234`, so a
 *      record stays recognisable across the change. Idempotent: rows
 *      already reissued do not match the WHERE clause.
 *   4. An AFTER count in the same shape as the before, plus a check that
 *      no `ne-`/`nl-` code is left in the federation.
 *
 * Nothing but the code column changes. Record ids are untouched, so
 * `description_entities` and `description_places` links survive
 * unchanged, and so does every route URL. The entities/places
 * AFTER-UPDATE FTS triggers do fire (they are unconditional), which
 * reindexes 500 rows on columns that did not change — harmless at this
 * size, and not worth dropping triggers for.
 *
 * Usage:
 *   npx tsx scripts/reissue-sbmal-authority-codes.ts
 *   npx tsx scripts/reissue-sbmal-authority-codes.ts --out reissue.sql
 *
 * @version v0.7.0
 */

import { AMPL_FEDERATION_ID } from "../app/lib/tenant";

// ---------------------------------------------------------------------------
// The one substitution this script exists to make
// ---------------------------------------------------------------------------

/**
 * Old prefix -> new prefix, per table. The new values are byte-for-byte
 * the ones migration 0068 writes onto the SBMAL tenant row
 * (`tenants.entity_code_prefix` / `place_code_prefix`), so the rows this
 * rewrites end up in the same series every future SBMAL mint uses.
 */
const REISSUES = [
  { table: "entities", column: "entity_code", from: "ne", to: "sbmal-e" },
  { table: "places", column: "place_code", from: "nl", to: "sbmal-p" },
] as const;

/** Codes are prefix + hyphen + six characters; nothing else is rewritable. */
const CODE_CHARS = 6;

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildSql(federationId: string): string {
  const fed = quote(federationId);

  const beforeAfter = (heading: string) =>
    REISSUES.map(
      ({ table, column, from, to }) => `
-- ${heading}: ${table}
SELECT ${quote(table)} AS table_name,
       COUNT(*) AS total,
       SUM(CASE WHEN ${column} LIKE ${quote(`${from}-%`)} THEN 1 ELSE 0 END) AS old_prefix,
       SUM(CASE WHEN ${column} LIKE ${quote(`${to}-%`)} THEN 1 ELSE 0 END) AS new_prefix,
       SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END) AS no_code,
       COUNT(DISTINCT tenant_id) AS owning_tenants
  FROM ${table}
 WHERE federation_id = ${fed};`,
    ).join("\n");

  const malformed = REISSUES.map(
    ({ table, column, from }) => `
SELECT ${quote(table)} AS table_name, id, ${column}
  FROM ${table}
 WHERE federation_id = ${fed}
   AND ${column} LIKE ${quote(`${from}-%`)}
   AND length(${column}) <> ${from.length + 1 + CODE_CHARS};`,
  ).join("\n");

  const collisions = REISSUES.map(
    ({ table, column, from, to }) => `
SELECT ${quote(table)} AS table_name,
       COUNT(*) AS collisions
  FROM ${table} src
  JOIN ${table} other
    ON other.federation_id = src.federation_id
   AND other.${column} = ${quote(`${to}-`)} || substr(src.${column}, ${from.length + 2})
 WHERE src.federation_id = ${fed}
   AND src.${column} LIKE ${quote(`${from}-%`)};`,
  ).join("\n");

  const updates = REISSUES.map(
    ({ table, column, from, to }) => `
UPDATE ${table}
   SET ${column} = ${quote(`${to}-`)} || substr(${column}, ${from.length + 2})
 WHERE federation_id = ${fed}
   AND ${column} LIKE ${quote(`${from}-%`)}
   AND length(${column}) = ${from.length + 1 + CODE_CHARS};`,
  ).join("\n");

  const leftovers = REISSUES.map(
    ({ table, column, from }) => `
SELECT ${quote(table)} AS table_name, id, ${column}
  FROM ${table}
 WHERE federation_id = ${fed}
   AND ${column} LIKE ${quote(`${from}-%`)};`,
  ).join("\n");

  return `-- Authority code reissue — AMPL federation
--
-- Re-marks entity codes ne-xxxxxx -> sbmal-e-xxxxxx and place codes
-- nl-xxxxxx -> sbmal-p-xxxxxx in federation
-- ${federationId}.
--
-- Generated by scripts/reissue-sbmal-authority-codes.ts. REVIEW BEFORE
-- RUNNING. This file was written, not executed: nothing has changed yet.
--
-- These codes were minted on 2026-08-12 under a hardcoded prefix that
-- named the wrong institution. They have never been published,
-- exported, or cited, and appear in no URL, which is the only reason
-- reissuing them is acceptable. An authority code is a citable
-- identifier; this is a one-off correction, not a maintenance routine.
--
-- Run part 1 and read the numbers. Run part 2 and confirm BOTH checks
-- return no rows and zero collisions. Only then run part 3. Part 4
-- confirms the result.
--
-- Record ids do not change, so description_entities /
-- description_places links and every route URL survive untouched.

-- --------------------------------------------------------------------
-- Part 1 — before
-- --------------------------------------------------------------------
${beforeAfter("Before")}

-- --------------------------------------------------------------------
-- Part 2 — pre-checks. Both must come back empty / zero.
--
-- (a) Malformed sources: a code carrying the old prefix but not exactly
--     prefix + ${CODE_CHARS} characters. The rewrite keeps everything after the
--     prefix, so a malformed row would come out malformed; part 3 skips
--     them by length, which means they would be left behind instead.
-- (b) Collisions: a rewritten code that already exists in this
--     federation. Codes are UNIQUE per (federation_id, code), so one
--     collision aborts the whole UPDATE.
-- --------------------------------------------------------------------
${malformed}
${collisions}

-- --------------------------------------------------------------------
-- Part 3 — the reissue
--
-- Prefix only; the six characters after it are preserved, so a record
-- stays recognisable across the change. Idempotent — a row already
-- carrying the new prefix does not match.
-- --------------------------------------------------------------------
${updates}

-- --------------------------------------------------------------------
-- Part 4 — after
--
-- The counts should mirror part 1 with old_prefix drained into
-- new_prefix, and the leftover query must return no rows.
-- --------------------------------------------------------------------
${beforeAfter("After")}
${leftovers}
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? null : argv[outIndex + 1];
  if (outIndex !== -1 && (!out || out.startsWith("--"))) {
    console.error("reissue-sbmal-authority-codes: --out needs a value");
    process.exit(1);
  }

  const sql = buildSql(AMPL_FEDERATION_ID);

  if (out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(out, sql, "utf-8");
    console.error(
      `reissue-sbmal-authority-codes: wrote ${out} — review before running`,
    );
    return;
  }
  process.stdout.write(sql);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void main();
}

export { buildSql };
