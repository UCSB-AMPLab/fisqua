/**
 * Reference Code Helpers
 *
 * This module deals with the server-side utilities for generating and
 * validating archival reference codes: per-fonds sequence increment,
 * duplicate detection, and the format rules that keep codes legible
 * across every surface that renders them.
 *
 * AUTHORITY CODES AND THE AGENCY PREFIX
 * -------------------------------------
 * An entity or place code is an agency prefix, a hyphen, and six
 * characters drawn from `AUTHORITY_CODE_ALPHABET` (30 characters, no
 * `i`/`l`/`o`/`u`/`0`/`1` — the pairs that get transcribed wrongly).
 * The prefix names the MAINTAINING AGENCY: whoever did the identifying,
 * extracting and enriching that produced the record. It is part of a
 * citable scholarly identifier, so it is issued once and never
 * rewritten.
 *
 * Until migration 0068 the two prefixes were a literal union in this
 * file — `ne` for entities, `nl` for places, short for "neogranadina
 * entidad" and "neogranadina lugar". That branded every institution's
 * records with Neogranadina's name. Now each agency carries its own
 * pair (`federations.entity_code_prefix` / `place_code_prefix`, and the
 * identical pair on `tenants`), and `resolveAuthorityCodePrefix` reads
 * whichever of the two rows actually maintains the record being minted.
 *
 * Two functions, used together at every mint site:
 *
 *   - `resolveAuthorityCodePrefix` answers "whose mark goes on this
 *     code?" from the owner `requireAuthorityMint` (or, for a split, the
 *     source record) already resolved. A NULL owner means the record
 *     lands in the federation's shared authority space, so the
 *     federation is the agency; a set owner means the tenant mints its
 *     own record and the tenant is the agency. That is deliberately the
 *     same shared-versus-owned test the mint gate performs, read once
 *     and used twice, so the gate and the mark cannot disagree.
 *
 *     It THROWS when the agency has no prefix configured. Falling back
 *     to a default would mean minting a code that claims the wrong
 *     institution made the record — the exact failure 0068 exists to
 *     end — and that failure is silent and permanent once the code is
 *     cited. A 500 on a create form is recoverable; a mismarked code is
 *     not.
 *
 *   - `generateUniqueCode` mints from a prefix and retries on
 *     collision. The prefix is now a plain string rather than a literal
 *     union; the alphabet and the retry loop are unchanged. Uniqueness
 *     is checked against the code column the caller passes, which the
 *     callers scope to their federation via the UNIQUE
 *     (federation_id, code) index behind it.
 *
 * The prefix is resolved from the OWNER, never from a record's current
 * `tenant_id` at read time. Ownership can be transferred; a published
 * code cannot follow it without becoming false.
 *
 * TWO GENERATIONS OF CODES COEXIST, ON PURPOSE
 * --------------------------------------------
 * Every code minted before 0068 carries `ne-`/`nl-`, and those codes
 * remain valid forever: they are issued identifiers and are never
 * reissued or rewritten to match the new scheme. A corpus holding both
 * generations is normal for archival identifier systems and is the
 * price of not breaking a single existing citation. (The sole
 * exception was a one-off, reviewed reissue of 500 codes minted on
 * 2026-08-12 and corrected before they were ever published or cited.)
 *
 * @version v0.7.0
 */
import { eq } from "drizzle-orm";
import { AUTHORITY_CODE_ALPHABET } from "./validation/authority-code";

/** 30-char alphabet: no i/l/o/u/0/1 to avoid visual ambiguity */
const ALPHABET = AUTHORITY_CODE_ALPHABET;

function generateCode(prefix: string): string {
  const chars = Array.from({ length: 6 }, () =>
    ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  ).join("");
  return `${prefix}-${chars}`;
}

/** Which of the two prefix columns a mint needs. */
export type AuthorityCodeKind = "entity" | "place";

/**
 * Resolve the code prefix for a record about to be minted into
 * `federationId` with owner `ownerTenantId` (the value
 * `requireAuthorityMint` returned, or — for a split — the source
 * record's own owner).
 *
 *   owner NULL -> federation-shared record; the FEDERATION is the
 *                 maintaining agency, so its prefix applies.
 *   owner set  -> tenant-owned record; the TENANT is the maintaining
 *                 agency, so its prefix applies.
 *
 * Throws when the resolved agency has no prefix configured, rather than
 * mint a code carrying somebody else's mark. The message names the row
 * to fix and the column to fill.
 */
export async function resolveAuthorityCodePrefix(
  db: any,
  kind: AuthorityCodeKind,
  federationId: string,
  ownerTenantId: string | null,
): Promise<string> {
  const { federations, tenants } = await import("../db/schema");

  if (ownerTenantId === null) {
    const column =
      kind === "entity"
        ? federations.entityCodePrefix
        : federations.placeCodePrefix;
    const row = await db
      .select({ prefix: column })
      .from(federations)
      .where(eq(federations.id, federationId))
      .get();
    return requirePrefix(row?.prefix, kind, "federations", federationId);
  }

  const column =
    kind === "entity" ? tenants.entityCodePrefix : tenants.placeCodePrefix;
  const row = await db
    .select({ prefix: column })
    .from(tenants)
    .where(eq(tenants.id, ownerTenantId))
    .get();
  return requirePrefix(row?.prefix, kind, "tenants", ownerTenantId);
}

/**
 * Turn a possibly-absent prefix into a usable one, or throw naming the
 * exact row and column an operator has to fill. A blank string counts as
 * absent: `''` would mint `-abc234`, which marks nothing.
 */
function requirePrefix(
  value: unknown,
  kind: AuthorityCodeKind,
  table: "federations" | "tenants",
  id: string,
): string {
  const prefix = typeof value === "string" ? value.trim() : "";
  if (prefix.length === 0) {
    const column =
      kind === "entity" ? "entity_code_prefix" : "place_code_prefix";
    throw new Error(
      `No ${kind} code prefix configured for ${table} row ${id} — set ` +
        `${table}.${column} before minting authority records for this ` +
        "agency; refusing to mint a code under another institution's mark",
    );
  }
  return prefix;
}

/**
 * Generate a unique authority code with collision retry. `prefix` is
 * the maintaining agency's mark, resolved by
 * `resolveAuthorityCodePrefix` — `ne` and `nl` for Neogranadina,
 * `sbmal-e` and `sbmal-p` for SBMAL, `<slug>-e` / `<slug>-p` for
 * agencies provisioned later.
 */
export async function generateUniqueCode(
  db: any,
  prefix: string,
  table: any,
  codeColumn: any,
  maxRetries = 5
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    const code = generateCode(prefix);
    const existing = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(codeColumn, code))
      .get();
    if (!existing) return code;
  }
  throw new Error(
    `Failed to generate unique ${prefix} code after ${maxRetries} retries`
  );
}
