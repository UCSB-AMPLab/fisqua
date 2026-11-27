/**
 * Capture Pairing — Stored Scanner Keys
 *
 * This module is the only reader of the B2 key pairs Fisqua keeps sealed
 * for a workspace's scanner in `capture_scanner_keys`, one row per
 * tenant. The operator's storing command writes the row; this module
 * reads it, opens it and erases it.
 *
 *   - `loadStoredKeys` gives the row as a `StoredKeysView`: the appliance
 *     id, bucket, age recipient, revision and the times of storing and
 *     erasure. It does not read the sealed text from D1: `usable` is
 *     computed there, as `sealed IS NOT NULL`, and is true while the row
 *     is not erased.
 *   - `openStoredKeys` opens the sealed text with the environment's
 *     private key, the Worker secret `CAPTURE_KEYS_PRIVATE_JWK`, through
 *     `openKeys` (`pairing-seal.ts`), with the tenant id and environment
 *     as the binding. It gives null when the workspace has no row or its
 *     row is erased. When the secret is absent or not JSON, or the sealed
 *     text does not open, it throws an Error with one fixed message, so
 *     that no part of the secret, the sealed text or the opened keys
 *     reaches a log through the error.
 *   - `eraseStoredKeysStatement` is the statement that erases the row:
 *     `sealed` to NULL, `erased_at` and `erased_by` set, `revision`
 *     raised by one. The bucket, appliance id and age recipient stay, so
 *     the names of the keys to revoke in B2 can still be given. The
 *     write is guarded by the row not being erased already and, when the
 *     caller gives the revision it read, by that revision, so a row
 *     changed since it was read is left as it was; without a revision it
 *     erases whatever usable row the workspace has when it runs. A caller
 *     may add a further condition to the guard, such as a revoke in the
 *     same batch having landed. The statement returns the erased row's
 *     appliance id (`RETURNING`), and uses `?` placeholders with their
 *     values beside them (`SqlStatement`), so a caller can put it in a
 *     D1 batch with its audit row.
 *   - `applianceKeyNames` gives the names of the two B2 keys, by the rule
 *     the minting command uses (`appliance-key-names.ts`).
 *
 * No function here logs or returns the sealed text.
 *
 * @version v0.9.0
 */

import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { captureScannerKeys } from "../../db/schema";
import { openKeys, type StoredKeyPairs } from "./pairing-seal";
import type { SqlStatement } from "./scanner-token";
import type { ApplianceKeyEnvironment } from "./appliance-key-names";

export { applianceKeyNames } from "./appliance-key-names";

export interface StoredKeysView {
  applianceId: string;
  bucket: string;
  ageRecipient: string;
  revision: number;
  storedAt: number;
  erasedAt: number | null;
  usable: boolean;
}

/** The one message every failure to open the stored keys carries. */
const OPEN_FAILED = "The stored scanner keys could not be opened";

type StoredRow = typeof captureScannerKeys.$inferSelect;

function viewOf(row: StoredRow): StoredKeysView {
  return {
    applianceId: row.applianceId,
    bucket: row.bucket,
    ageRecipient: row.ageRecipient,
    revision: row.revision,
    storedAt: row.storedAt,
    erasedAt: row.erasedAt ?? null,
    usable: row.sealed !== null,
  };
}

async function readRow(db: DrizzleD1Database<any>, tenantId: string): Promise<StoredRow | undefined> {
  return db.select().from(captureScannerKeys).where(eq(captureScannerKeys.tenantId, tenantId)).get();
}

/** The workspace's stored keys without the sealed text, or null if none were stored. */
export async function loadStoredKeys(db: DrizzleD1Database<any>, tenantId: string): Promise<StoredKeysView | null> {
  const row = await db
    .select({
      applianceId: captureScannerKeys.applianceId,
      bucket: captureScannerKeys.bucket,
      ageRecipient: captureScannerKeys.ageRecipient,
      revision: captureScannerKeys.revision,
      storedAt: captureScannerKeys.storedAt,
      erasedAt: captureScannerKeys.erasedAt,
      usable: sql<number>`${captureScannerKeys.sealed} IS NOT NULL`,
    })
    .from(captureScannerKeys)
    .where(eq(captureScannerKeys.tenantId, tenantId))
    .get();
  if (!row) return null;
  return {
    applianceId: row.applianceId,
    bucket: row.bucket,
    ageRecipient: row.ageRecipient,
    revision: row.revision,
    storedAt: row.storedAt,
    erasedAt: row.erasedAt ?? null,
    usable: Boolean(row.usable),
  };
}

/** The workspace's stored keys opened, or null when none are stored or they are erased. */
export async function openStoredKeys(
  db: DrizzleD1Database<any>,
  env: { CAPTURE_KEYS_PRIVATE_JWK?: string },
  tenantId: string,
  environment: ApplianceKeyEnvironment,
): Promise<{ view: StoredKeysView; keys: StoredKeyPairs } | null> {
  const row = await readRow(db, tenantId);
  if (!row || row.sealed === null) return null;
  const secret = env.CAPTURE_KEYS_PRIVATE_JWK;
  let keys: StoredKeyPairs | null = null;
  if (secret) {
    try {
      keys = await openKeys(JSON.parse(secret) as JsonWebKey, row.sealed, { tenantId, environment });
    } catch {
      // Any failure gets the one fixed message below.
    }
  }
  if (!keys) throw new Error(OPEN_FAILED);
  return { view: viewOf(row), keys };
}

/**
 * The guarded statement that erases the workspace's stored keys, and
 * returns the erased row's appliance id. With `seenRevision`, only the
 * row as read at that revision is erased; without it, whatever usable
 * row the workspace has when the statement runs. `onlyIf`, when given,
 * is a further condition the erasure needs, added to the WHERE clause.
 */
export function eraseStoredKeysStatement(
  tenantId: string,
  seenRevision: number | undefined,
  actorUserId: string,
  now: number,
  onlyIf?: SqlStatement,
): SqlStatement {
  const revision = seenRevision === undefined ? [] : [seenRevision];
  return {
    sql:
      "UPDATE capture_scanner_keys SET sealed = NULL, erased_at = ?, erased_by = ?, revision = revision + 1\n" +
      "WHERE tenant_id = ?" +
      (seenRevision === undefined ? "" : " AND revision = ?") +
      " AND sealed IS NOT NULL" +
      (onlyIf ? ` AND (${onlyIf.sql})` : "") +
      "\nRETURNING appliance_id;",
    params: [now, actorUserId, tenantId, ...revision, ...(onlyIf?.params ?? [])],
  };
}

// @version v0.9.0
