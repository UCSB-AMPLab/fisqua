/**
 * Capture Pairing — Routes
 *
 * This module deals with the two calls of contract 1.11 (§12) that a
 * Captua unit makes with no token, on Fisqua's main address, to be
 * linked to its workspace by a six-character code. The route files are
 * thin adapters: each builds a `PairingDeps` from the Worker's context
 * and hands the request to a handler here, so the tests drive the
 * handlers with a database, a clock and an `env` of their own.
 *
 * `handlePairingCodes` answers `POST /api/capture/v1/pairing/codes`,
 * the unit's request for a code. It works through a fixed order, and
 * every early return writes nothing except the rate counter:
 *
 *   1. On any host but `CAPTURE_PAIRING_ORIGIN`, or with that setting
 *      unset or empty, every method gets a bare 404 with no body and no
 *      `Content-Type`: the answer a Fisqua without pairing gives, which
 *      the contract (§12.3) tells the unit to read as "cannot pair". A
 *      workspace's own host is never a pairing address.
 *   2. A method other than POST is 405 `{ "rule": "method" }`.
 *   3. The body has to be a JSON object of at most `MAX_BODY_BYTES`.
 *      `unitName` is 1 to 64 characters after trimming, with no control
 *      or format characters (`\p{Cc}`, `\p{Cf}`, which include the
 *      bidirectional overrides that could make a name mislead the
 *      approver), no lone surrogates (`\p{Cs}`), no private-use
 *      characters (`\p{Co}`) and no line or paragraph separators
 *      (`\p{Zl}`, `\p{Zp}`), and is stored trimmed; `deviceId`, and
 *      `currentTenant` when it is present, match the scanner name shape
 *      (`SCANNER_NAME_PATTERN`). The first field that fails names the
 *      400's rule: `unit-name`, `device-id` or `current-tenant`. A body
 *      that is not a JSON object has no valid `unitName`, so it is
 *      `unit-name` too. `currentTenant` is never looked up.
 *   4. Rows more than a day old are deleted, at most
 *      `CLEANUP_BATCH` of each kind per request: code rows in any state
 *      whose `expires_at` is more than a day before now, and limit rows
 *      whose `window_start` is. The request side does this rather than
 *      the cron because staging has no cron.
 *   5. The request counts against `codes-ip:<SHA-256 of the subject>`,
 *      where `addressLimitSubject` gives the subject: an IPv6 address
 *      counts by its /64 (one /64 is one customer's network), an IPv4
 *      address or an IPv4-mapped IPv6 address counts whole, and a
 *      missing or unreadable address counts as `"unknown"`, so all such
 *      requests share one count. A dotted IPv4 group is read only as
 *      the last group of an IPv6 address. Past `CODES_PER_ADDRESS` in a
 *      `CODES_WINDOW_MS` window, the answer is 429 `rate-limited` with
 *      `Retry-After` until the window turns. The address itself is
 *      never stored.
 *   6. At `MAX_LIVE_CODES` waiting codes that have not expired, 429
 *      `rate-limited` with `Retry-After` of one code lifetime. The cap is
 *      a condition of the INSERT in step 7 (its count reads a range of
 *      the `expires_at` index), so requests sent at once cannot together
 *      pass it: an INSERT that writes no row, and raises no error, is
 *      this answer.
 *   7. A `waiting` row is written with the SHA-256 of a fresh code and
 *      of a fresh collect secret, and the answer is 201 with the code,
 *      the secret, `expiresInSeconds` and `pollSeconds`. When the code's
 *      hash is already stored, old code rows are deleted as in step 4
 *      and a new code is drawn, up to `MAX_CODE_DRAWS` draws in all;
 *      after that the answer is 503 `{ "rule": "busy" }` with
 *      `Retry-After: 5`.
 *
 * An unexpected error after step 2, such as a failed D1 statement, is
 * answered 503 `busy` with `Retry-After: 5`, so the unit gets JSON and
 * tries again. The log line is the fixed tag `pairing codes: unexpected
 * error` and the error's name, never its message, which could quote the
 * body.
 *
 * Every answer but the bare 404 is built by `json`: a JSON object body,
 * `Content-Type: application/json` and `Cache-Control: no-store`. The
 * collect route's handler is in `pairing-collect.server.ts`; it uses
 * `json`, `busy`, `rateLimited`, `readObject`, the origin and method
 * checks and `PairingDeps` from here.
 *
 * @version v0.9.0
 */
import { inArray, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { capturePairingCodes, capturePairingLimits } from "../../db/schema";
import { bareNotFound, readCappedBody } from "../pipeline/callback.server";
import { CODE_TTL_MS, POLL_SECONDS, newCollectSecret, newPairingCode } from "./pairing-code";
import { countHit } from "./pairing-limits.server";
import { SCANNER_NAME_PATTERN, sha256Hex } from "./token";

export const CODES_PER_ADDRESS = 20;
export const CODES_WINDOW_MS = 10 * 60 * 1000;
export const MAX_LIVE_CODES = 1000;
export const MAX_CODE_DRAWS = 5;
export const MAX_BODY_BYTES = 4096;
export const MAX_UNIT_NAME_CHARS = 64;
export const CLEANUP_BATCH = 50;
const STALE_ROW_MS = 24 * 60 * 60 * 1000;
const BUSY_RETRY_SECONDS = 5;

export interface PairingDeps {
  db: DrizzleD1Database<any>;
  env: Env;
  now: () => number;
  newId: () => string;
  /** The client's address, from `CF-Connecting-IP`; null when absent. */
  clientAddress: (r: Request) => string | null;
  /** Draws a code; `newPairingCode` when absent. Tests set it to force collisions. */
  newCode?: () => string;
}

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function pairingMethodNotAllowed(): Response {
  return json(405, { rule: "method" }, { Allow: "POST" });
}

/** 429 `rate-limited` with `Retry-After`. */
export const rateLimited = (retryAfterSeconds: number) =>
  json(429, { rule: "rate-limited" }, { "Retry-After": String(retryAfterSeconds) });

/** True when the request is on the configured main address. */
export function isPairingOrigin(request: Request, env: Env): boolean {
  const configured = env.CAPTURE_PAIRING_ORIGIN;
  if (!configured) return false;
  try {
    return new URL(request.url).origin === new URL(configured).origin;
  } catch {
    return false;
  }
}

/** The `CF-Connecting-IP` header, or null. */
export function clientAddress(request: Request): string | null {
  return request.headers.get("CF-Connecting-IP");
}

// ---------------------------------------------------------------------------
// The address limit's subject
// ---------------------------------------------------------------------------

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

function parseIpv4(text: string): number[] | null {
  const m = IPV4.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** The eight hextets of an IPv6 address, or null when it is not one. */
function parseIpv6(text: string): number[] | null {
  const lower = text.toLowerCase();
  const halves = lower.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const words: Array<string | number> = [];
  const all = [...head, ...tail];
  // A dotted IPv4 tail stands for the last two hextets. It has to be the
  // last group of the address, so it cannot sit before a trailing `::`.
  const last = all[all.length - 1];
  let v4: number[] | null = null;
  if (last !== undefined && last.includes(".")) {
    if (halves.length === 2 && tail.length === 0) return null;
    v4 = parseIpv4(last);
    if (!v4) return null;
    if (tail.length > 0) tail.pop();
    else head.pop();
  }
  for (const g of [...head, ...tail]) if (!HEXTET.test(g)) return null;
  const v4Words = v4 ? [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]] : [];
  const given = head.length + tail.length + v4Words.length;
  if (halves.length === 2) {
    if (given > 7) return null;
    words.push(
      ...head.map((g) => parseInt(g, 16)),
      ...new Array(8 - given).fill(0),
      ...tail.map((g) => parseInt(g, 16)),
      ...v4Words,
    );
  } else {
    if (given !== 8) return null;
    words.push(...head.map((g) => parseInt(g, 16)), ...v4Words);
  }
  return words as number[];
}

/**
 * What the address limit counts a client address under: an IPv4
 * address whole; an IPv4-mapped IPv6 address as its IPv4 address; any
 * other IPv6 address as its /64, the first four hextets expanded to
 * four lower-case digits each; and `"unknown"` for a missing address or
 * one that is neither.
 */
export function addressLimitSubject(address: string | null): string {
  if (!address) return "unknown";
  const v4 = parseIpv4(address);
  if (v4) return v4.join(".");
  if (!address.includes(":")) return "unknown";
  const w = parseIpv6(address);
  if (!w) return "unknown";
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) {
    return [w[6] >> 8, w[6] & 0xff, w[7] >> 8, w[7] & 0xff].join(".");
  }
  return w
    .slice(0, 4)
    .map((x) => x.toString(16).padStart(4, "0"))
    .join(":");
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

type CodesBody = { unitName: string; deviceId: string; currentTenant: string | null };
type CodesRule = "unit-name" | "device-id" | "current-tenant";

// Control characters (C0, DEL, C1), format characters (such as the
// bidirectional overrides and zero-width characters), lone surrogates,
// private-use characters, and the line and paragraph separators.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

/** The body as a JSON object of at most `MAX_BODY_BYTES`, or null. */
export async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  const bytes = await readCappedBody(request, MAX_BODY_BYTES);
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function validateCodesBody(raw: Record<string, unknown> | null): CodesBody | { rule: CodesRule } {
  const body = raw ?? {};
  const unitName = typeof body.unitName === "string" ? body.unitName.trim() : null;
  if (
    unitName === null ||
    unitName.length === 0 ||
    [...unitName].length > MAX_UNIT_NAME_CHARS ||
    CONTROL_OR_FORMAT.test(unitName)
  ) {
    return { rule: "unit-name" };
  }
  const { deviceId, currentTenant } = body;
  if (typeof deviceId !== "string" || !SCANNER_NAME_PATTERN.test(deviceId)) {
    return { rule: "device-id" };
  }
  if (
    currentTenant !== undefined &&
    (typeof currentTenant !== "string" || !SCANNER_NAME_PATTERN.test(currentTenant))
  ) {
    return { rule: "current-tenant" };
  }
  return { unitName, deviceId, currentTenant: currentTenant ?? null };
}

/** Deletes at most `CLEANUP_BATCH` code rows that expired more than a day ago. */
function deleteOldCodes(db: PairingDeps["db"], now: number) {
  const old = db
    .select({ id: capturePairingCodes.id })
    .from(capturePairingCodes)
    .where(lt(capturePairingCodes.expiresAt, now - STALE_ROW_MS))
    .limit(CLEANUP_BATCH);
  return db.delete(capturePairingCodes).where(inArray(capturePairingCodes.id, old));
}

/** Deletes at most `CLEANUP_BATCH` limit rows whose window began more than a day ago. */
function deleteOldLimits(db: PairingDeps["db"], now: number) {
  const old = db
    .select({ key: capturePairingLimits.key })
    .from(capturePairingLimits)
    .where(lt(capturePairingLimits.windowStart, now - STALE_ROW_MS))
    .limit(CLEANUP_BATCH);
  return db.delete(capturePairingLimits).where(inArray(capturePairingLimits.key, old));
}

function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 5; depth++) {
    if (/UNIQUE constraint failed/i.test(String((current as Error).message ?? current))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// POST /api/capture/v1/pairing/codes
// ---------------------------------------------------------------------------

export async function handlePairingCodes(deps: PairingDeps, request: Request): Promise<Response> {
  if (!isPairingOrigin(request, deps.env)) return bareNotFound();
  if (request.method !== "POST") return pairingMethodNotAllowed();
  try {
    return await issueCode(deps, request);
  } catch (err) {
    console.error(`pairing codes: unexpected error: ${err instanceof Error ? err.name : "error"}`);
    return busy();
  }
}

/** 503 `busy` with `Retry-After: 5`. */
export const busy = () => json(503, { rule: "busy" }, { "Retry-After": String(BUSY_RETRY_SECONDS) });

async function issueCode(deps: PairingDeps, request: Request): Promise<Response> {
  const valid = validateCodesBody(await readObject(request));
  if ("rule" in valid) return json(400, { rule: valid.rule });

  const now = deps.now();
  await deps.db.batch([deleteOldCodes(deps.db, now), deleteOldLimits(deps.db, now)]);

  const subject = addressLimitSubject(deps.clientAddress(request));
  const counted = await countHit(
    deps.db,
    `codes-ip:${await sha256Hex(subject)}`,
    CODES_PER_ADDRESS,
    CODES_WINDOW_MS,
    now,
  );
  if (!counted.ok) return rateLimited(counted.retryAfterSeconds);

  const draw = deps.newCode ?? newPairingCode;
  const collectSecret = newCollectSecret();
  const collectSecretSha256 = await sha256Hex(collectSecret);
  for (let attempt = 1; attempt <= MAX_CODE_DRAWS; attempt++) {
    const code = draw();
    let inserted: D1Result;
    try {
      // The live-code cap is part of the INSERT, so requests sent at once
      // cannot all pass it.
      inserted = await deps.env.DB.prepare(
        "INSERT INTO capture_pairing_codes (id, code_sha256, collect_secret_sha256, unit_name, device_id, " +
          "current_tenant, state, created_at, expires_at)\n" +
          "SELECT ?, ?, ?, ?, ?, ?, 'waiting', ?, ?\n" +
          "WHERE (SELECT count(*) FROM capture_pairing_codes WHERE expires_at > ? AND state = 'waiting') < ?;",
      )
        .bind(
          deps.newId(),
          await sha256Hex(code),
          collectSecretSha256,
          valid.unitName,
          valid.deviceId,
          valid.currentTenant,
          now,
          now + CODE_TTL_MS,
          now,
          MAX_LIVE_CODES,
        )
        .run();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await deleteOldCodes(deps.db, now);
      continue;
    }
    // No row and no error: the live codes are at the cap.
    if (inserted.meta.changes !== 1) return rateLimited(CODE_TTL_MS / 1000);
    return json(201, {
      code,
      collectSecret,
      expiresInSeconds: CODE_TTL_MS / 1000,
      pollSeconds: POLL_SECONDS,
    });
  }
  return busy();
}

// @version v0.9.0
