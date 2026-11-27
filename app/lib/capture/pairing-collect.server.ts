/**
 * Capture Pairing — Collecting
 *
 * This module answers the second call of contract 1.11 (§12.2), which a
 * Captua unit polls with no token, on Fisqua's main address, until it
 * receives its link token, its workspace's bucket keys and the backup
 * key, once. It is the only route that returns key material. The route
 * file builds a `PairingDeps` (`pairing.server.ts`) and hands the
 * request here; the answer helpers, the body reader and the origin and
 * method checks are shared with the codes route in that module.
 *
 * `handlePairingCollect` answers `POST /api/capture/v1/pairing/collect`,
 * with the unit's code and collect secret in the body, in this order:
 *
 *   1-2. The address and the method, as for the codes route.
 *   3. A body that is not a JSON object with a string `code` and a
 *      string `collectSecret`, or a code that `normalizePairingCode`
 *      does not read, is 404 `{ "state": "unknown" }`.
 *   4. The code row is looked up by the SHA-256 of the code, and the
 *      SHA-256 of the secret is compared with the stored one without
 *      stopping at the first difference. No row and a wrong secret give
 *      the same 404 `unknown`, and neither writes anything.
 *   5. The poll counts on the code row, `POLLS_PER_MINUTE` in a
 *      one-minute window, in one UPDATE ... RETURNING; past it, 429
 *      `rate-limited` with `Retry-After` until the window turns.
 *   6. `collected` is 410 `collected`. `void`, `waiting` past
 *      `expires_at` and `approved` past `collect_by` are 410 `expired`,
 *      and the code is set `void`. `waiting` in time is 202 `waiting`.
 *   7. An `approved` code in time is checked against the workspace as
 *      the approver saw it: the scanner's revision (0 when it had none)
 *      and the stored keys' revision, which must be present and not
 *      erased. A difference sets the code `void` and answers 410
 *      `expired`. Stored keys that cannot be opened (the private key is
 *      missing or wrong) are an operator's fault: 503 `busy`, with the
 *      code left `approved`.
 *   8. The keys are opened in step 7, before any token exists. A token
 *      is then minted, and one D1 batch runs
 *      `pairingTokenStatements` (`scanner-token.ts`): the code row to
 *      `collected`, then the scanner write, then a `scanner_token` audit
 *      row `{ step: "pair_collected", unitName, deviceId }` with the
 *      approver as actor, inserted only if the scanner write landed. When
 *      the write renames the scanner, the row also carries `previousName`,
 *      the name it had, which names the B2 keys the replaced unit holds.
 *      The answer is decided from the batch's own result, with no
 *      further read of the scanner: when the scanner write changed one
 *      row, 200 with the payload. The code row's update and the
 *      scanner write are guarded alike, so they land together or not
 *      at all. When nothing landed, the code is read again: a code
 *      another poll collected is 410 `collected`, and any other code is
 *      set `void` and answered 410 `expired`.
 *
 * A 503 is logged as a fixed tag (`pairing collect: unexpected error`
 * or `pairing collect: stored keys could not be opened`) and the error's
 * name. The code, the secret, the token, the keys and any error message
 * are never logged.
 *
 * @version v0.9.0
 */
import { normalizePairingCode } from "./pairing-code";
import {
  busy,
  isPairingOrigin,
  json,
  pairingMethodNotAllowed,
  rateLimited,
  readObject,
  type PairingDeps,
} from "./pairing.server";
import { bareNotFound } from "../pipeline/callback.server";
import { openStoredKeys } from "./scanner-keys.server";
import type { ApplianceKeyEnvironment } from "./appliance-key-names";
import {
  pairingLandedCondition,
  pairingTokenStatements,
  rowOfScanner,
  scannerQuery,
  type PairingTokenWrite,
  type SqlStatement,
} from "./scanner-token";
import { mintScannerToken, sha256Hex } from "./token";


export const POLLS_PER_MINUTE = 30;
const POLL_WINDOW_MS = 60_000;
/** Compared against when no code row matches, so both paths do the same work. */
const NO_SECRET = "0".repeat(64);

type CodeRow = {
  id: string;
  collect_secret_sha256: string;
  unit_name: string;
  device_id: string;
  state: "waiting" | "approved" | "collected" | "void";
  expires_at: number;
  tenant_id: string | null;
  approved_by: string | null;
  collect_by: number | null;
  scanner_revision_seen: number | null;
  keys_revision_seen: number | null;
};

const unknownCode = () => json(404, { state: "unknown" });
const expiredCode = () => json(410, { state: "expired" });
const collectedCode = () => json(410, { state: "collected" });

/** Compares two hex digests without stopping at the first difference. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bind(d1: D1Database, s: SqlStatement) {
  return d1.prepare(s.sql).bind(...s.params);
}

/** Sets a code `void` from the state it was read in. */
function voidCode(d1: D1Database, id: string, from: CodeRow["state"]) {
  return d1.prepare("UPDATE capture_pairing_codes SET state = 'void' WHERE id = ? AND state = ?").bind(id, from).run();
}

export async function handlePairingCollect(deps: PairingDeps, request: Request): Promise<Response> {
  if (!isPairingOrigin(request, deps.env)) return bareNotFound();
  if (request.method !== "POST") return pairingMethodNotAllowed();
  try {
    return await collectCode(deps, request);
  } catch (err) {
    console.error(`pairing collect: unexpected error: ${err instanceof Error ? err.name : "error"}`);
    return busy();
  }
}

async function collectCode(deps: PairingDeps, request: Request): Promise<Response> {
  const body = await readObject(request);
  const code = typeof body?.code === "string" ? normalizePairingCode(body.code) : null;
  const secret = typeof body?.collectSecret === "string" ? body.collectSecret : null;
  if (code === null || secret === null) return unknownCode();

  const d1 = deps.env.DB;
  const row = await d1
    .prepare(
      "SELECT id, collect_secret_sha256, unit_name, device_id, state, expires_at, tenant_id, approved_by, " +
        "collect_by, scanner_revision_seen, keys_revision_seen FROM capture_pairing_codes WHERE code_sha256 = ?",
    )
    .bind(await sha256Hex(code))
    .first<CodeRow>();
  const secretMatches = sameDigest(await sha256Hex(secret), row?.collect_secret_sha256 ?? NO_SECRET);
  if (!row || !secretMatches) return unknownCode();

  const now = deps.now();
  const window = Math.floor(now / POLL_WINDOW_MS) * POLL_WINDOW_MS;
  const polled = await d1
    .prepare(
      "UPDATE capture_pairing_codes SET poll_window_calls = CASE WHEN poll_window_start = ? " +
        "THEN poll_window_calls + 1 ELSE 1 END, poll_window_start = ? WHERE id = ? RETURNING poll_window_calls AS calls",
    )
    .bind(window, window, row.id)
    .first<{ calls: number }>();
  if (!polled) return unknownCode();
  if (polled.calls > POLLS_PER_MINUTE) {
    return rateLimited(Math.max(1, Math.ceil((window + POLL_WINDOW_MS - now) / 1000)));
  }

  switch (row.state) {
    case "collected":
      return collectedCode();
    case "void":
      return expiredCode();
    case "waiting":
      if (now < row.expires_at) return json(202, { state: "waiting" });
      await voidCode(d1, row.id, "waiting");
      return expiredCode();
  }
  if (row.collect_by === null || now >= row.collect_by || row.tenant_id === null) {
    await voidCode(d1, row.id, "approved");
    return expiredCode();
  }
  return deliver(deps, row, row.tenant_id, now);
}

/** An approved code within its window: issue the token and answer the payload, or 410. */
async function deliver(deps: PairingDeps, row: CodeRow, tenantId: string, now: number): Promise<Response> {
  const d1 = deps.env.DB;
  const environment = deps.env.CAPTURE_PAIRING_ENVIRONMENT as string | undefined;
  if (environment !== "production" && environment !== "staging") {
    console.error("pairing collect: no pairing environment configured");
    return busy();
  }
  const tenant = await d1.prepare("SELECT slug FROM tenants WHERE id = ?").bind(tenantId).first<{ slug: string }>();
  const scan = scannerQuery(tenantId);
  const { results } = await bind(d1, scan).all<Record<string, unknown>>();
  const scanners = results.map(rowOfScanner);
  const current = scanners[0] ?? null;
  if (!tenant || scanners.length > 1 || (current?.revision ?? 0) !== row.scanner_revision_seen) {
    await voidCode(d1, row.id, "approved");
    return expiredCode();
  }

  let opened: Awaited<ReturnType<typeof openStoredKeys>>;
  try {
    // The private key is a Worker secret, which the generated `Env` type does not list.
    const secrets = deps.env as unknown as { CAPTURE_KEYS_PRIVATE_JWK?: string };
    opened = await openStoredKeys(deps.db, secrets, tenantId, environment as ApplianceKeyEnvironment);
  } catch (err) {
    // The private key is missing or does not open the stored keys: an
    // operator's fault, not the unit's. The code stays approved, so a
    // later poll within the window can still collect.
    console.error(`pairing collect: stored keys could not be opened: ${err instanceof Error ? err.name : "error"}`);
    return busy();
  }
  if (!opened || opened.view.revision !== row.keys_revision_seen) {
    await voidCode(d1, row.id, "approved");
    return expiredCode();
  }

  const minted = await mintScannerToken();
  const write: PairingTokenWrite = {
    codeId: row.id,
    tenantId,
    current,
    newScannerId: deps.newId(),
    applianceId: opened.view.applianceId,
    unitName: row.unit_name,
    deviceId: row.device_id,
    sha256: minted.sha256,
    now,
    writeId: deps.newId(),
    keysRevisionSeen: opened.view.revision,
  };
  const [collect, scannerWrite] = pairingTokenStatements(write);
  const landed = pairingLandedCondition(write);
  const scannerId = current?.id ?? write.newScannerId;
  // The approval's audit row gives the actor's name and home workspace
  // as they were at approval; the user row, or the code's own fields,
  // stand in when it is absent.
  const audit: SqlStatement = {
    sql:
      "INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action, " +
      "target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details)\n" +
      "SELECT ?, ?, ?, COALESCE(a.actor_user_id_text, u.email, ?), COALESCE(a.actor_tenant_id, u.tenant_id, ?), " +
      "'scanner_token', ?, 'capture_scanner', ?, NULL, ?\n" +
      "FROM (SELECT 1) LEFT JOIN users u ON u.id = ?\n" +
      "LEFT JOIN (SELECT actor_user_id_text, actor_tenant_id FROM audit_log WHERE action = 'scanner_token' " +
      "AND target_tenant_id = ? AND target_object_kind = 'capture_pairing_code' AND target_object_id = ? " +
      "ORDER BY created_at DESC LIMIT 1) a ON 1 = 1\n" +
      `WHERE EXISTS (SELECT 1 FROM capture_scanners WHERE ${landed.sql});`,
    params: [
      deps.newId(),
      now,
      row.approved_by,
      row.approved_by ?? "unknown",
      tenantId,
      tenantId,
      scannerId,
      JSON.stringify({
        step: "pair_collected",
        unitName: row.unit_name,
        deviceId: row.device_id,
        // The renamed scanner's former name names the replaced unit's B2 keys.
        ...(current && current.name !== opened.view.applianceId ? { previousName: current.name } : {}),
      }),
      row.approved_by,
      tenantId,
      row.id,
      ...landed.params,
    ],
  };
  const outcome = await d1.batch([bind(d1, collect), bind(d1, scannerWrite), bind(d1, audit)]);

  // The scanner write is guarded by `changes() = 1` on the code row's
  // update and by the same scanner condition, so its own change count
  // says whether this poll issued the token. No further read is made:
  // the token has landed, and only this answer carries it.
  // This rule depends on no trigger or cascade writing rows on a `capture_scanners` insert or update.
  if (outcome[1].meta.changes === 1) {
    return json(200, {
      tenant: tenant.slug,
      environment,
      token: minted.token,
      bucket: opened.view.bucket,
      writeKey: opened.keys.writeKey,
      readKey: opened.keys.readKey,
      ageRecipient: opened.view.ageRecipient,
    });
  }
  // Something changed between the read and the batch: an earlier poll
  // collected, or a token write, a new store or an erasure intervened.
  const after = await d1.prepare("SELECT state FROM capture_pairing_codes WHERE id = ?").bind(row.id).first<{ state: string }>();
  if (after?.state === "collected") return collectedCode();
  await voidCode(d1, row.id, "approved");
  return expiredCode();
}

// @version v0.9.0
