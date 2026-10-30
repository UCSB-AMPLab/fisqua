/**
 * Media Pipeline — Run Token
 *
 * This module deals with the bearer token a pipeline run's jobs present
 * when they report back to Fisqua, and with how long that token and the
 * presigned spec URL stay valid.
 *
 * `mintRunToken` makes one token per run: 32 random bytes in base64url
 * without padding, prefixed `fpr_`, so a token is recognisable in a
 * leaked log line. It returns the plaintext and its SHA-256 as lowercase
 * hex. Only the hash is stored on the run row; the plaintext leaves the
 * Worker inside the run spec and nowhere else. `hashRunToken` recomputes
 * the hash.
 *
 * `parseBearer` accepts exactly `Bearer <token>` (the scheme in any
 * case, one space, a well-formed token) and returns `null` otherwise.
 *
 * `verifyRunToken` answers `ok`, `invalid` or `expired`. It hashes the
 * presented token once on every path — a fixed placeholder when none was
 * presented — and compares the digest with the stored hash, or with an
 * all-zero digest when no run was found, using a constant-time
 * comparison over two 32-byte values. An unknown run therefore costs the
 * same work as a wrong token. The hash is compared before expiry is
 * looked at, so a caller without the right token never learns whether a
 * run has expired. Revocation and run status are not checked here: they
 * are run-state questions the callback handlers answer after this.
 *
 * `runLifetimes` computes the two expiry times when a run starts. It
 * estimates the run's makespan — the longer of the longest job and the
 * total job time spread over the available lanes, plus spacing between
 * dispatch chunks and an allowance for queueing — which is when the last
 * chunk-completion job starts. The spec URL lasts for that estimate
 * times a margin, or a floor, whichever is longer, because every job,
 * the completion job included, fetches the spec through it. The token
 * outlives the URL by at least the longest job plus the callback tail
 * (the runner's retries), or lasts to its own floor, whichever is later.
 * A job that starts before the URL expires can therefore always finish
 * and report. The tail must be positive, so the URL always expires
 * strictly before the token; `assertLifetimeConstants` refuses
 * constants that break this, and `runLifetimes` calls it.
 *
 * `runLifetimes` does not clamp to `PRESIGN_MAX_SECONDS`, the seven-day
 * ceiling of a presigned URL; the dispatcher refuses a run that would
 * need longer.
 *
 * Nothing here logs: a token must never reach a log line.
 *
 * @version v0.8.0
 */

const TOKEN_PREFIX = "fpr_";
const TOKEN_PATTERN = /^fpr_[A-Za-z0-9_-]{43}$/;
const BEARER_PATTERN = /^bearer (\S+)$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

// Hashed in place of a missing token, so every verification path hashes
// exactly once.
const ABSENT_TOKEN_PLACEHOLDER = "fpr_absent";
// Compared against when no run row was found.
const DUMMY_DIGEST = new Uint8Array(32);

// The Workers runtime adds a constant-time comparison to SubtleCrypto.
// The project's TypeScript config resolves `crypto` through the DOM
// library, which does not declare it, so the method is typed here.
type WorkersSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
};

/** The longest lifetime a SigV4 presigned URL may have, in seconds. */
export const PRESIGN_MAX_SECONDS = 604_800;

export interface MintedToken {
  token: string;
  /** SHA-256 of `token`, 64 lowercase hex characters. */
  hash: string;
}

export type TokenCheck = "ok" | "invalid" | "expired";

export interface LifetimeInputs {
  totalImages: number;
  jobImageCounts: number[];
  chunkCount: number;
}

export interface LifetimeConstants {
  secondsPerImage: number;
  perJobOverheadSeconds: number;
  lanes: number;
  chunkSpacingSeconds: number;
  queueAllowanceSeconds: number;
  marginFactor: number;
  tokenFloorSeconds: number;
  urlFloorSeconds: number;
  /** Must be greater than zero, so the URL expires before the token. */
  callbackTailSeconds: number;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array | null {
  if (!HASH_PATTERN.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function digest(token: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return new Uint8Array(buf);
}

export async function hashRunToken(token: string): Promise<string> {
  return toHex(await digest(token));
}

export async function mintRunToken(): Promise<MintedToken> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = TOKEN_PREFIX + base64url(bytes);
  return { token, hash: await hashRunToken(token) };
}

export function parseBearer(header: string | null): string | null {
  if (header === null) return null;
  const match = BEARER_PATTERN.exec(header);
  if (!match) return null;
  const token = match[1];
  return TOKEN_PATTERN.test(token) ? token : null;
}

export async function verifyRunToken(
  stored: { hash: string; expiresAt: number } | null,
  presented: string | null,
  now: number,
): Promise<TokenCheck> {
  const presentedDigest = await digest(presented ?? ABSENT_TOKEN_PLACEHOLDER);
  const storedDigest = (stored && fromHex(stored.hash)) ?? DUMMY_DIGEST;
  const equal = (crypto.subtle as WorkersSubtleCrypto).timingSafeEqual(
    presentedDigest,
    storedDigest,
  );
  if (presented === null || stored === null || !equal || storedDigest === DUMMY_DIGEST) {
    return "invalid";
  }
  if (now >= stored.expiresAt) return "expired";
  return "ok";
}

export function assertLifetimeConstants(k: LifetimeConstants): void {
  if (!(k.callbackTailSeconds > 0)) {
    throw new Error("Pipeline lifetime constants: callbackTailSeconds must be greater than zero");
  }
  if (!(k.lanes >= 1)) {
    throw new Error("Pipeline lifetime constants: lanes must be at least one");
  }
}

export function runLifetimes(
  now: number,
  inputs: LifetimeInputs,
  k: LifetimeConstants,
): { specUrlExpiresAt: number; tokenExpiresAt: number } {
  assertLifetimeConstants(k);
  const jobSeconds = inputs.jobImageCounts.map(
    (images) => images * k.secondsPerImage + k.perJobOverheadSeconds,
  );
  const longestJobSeconds = jobSeconds.length ? Math.max(...jobSeconds) : 0;
  const totalJobSeconds = jobSeconds.reduce((a, b) => a + b, 0);
  const makespan =
    Math.max(longestJobSeconds, totalJobSeconds / k.lanes) +
    inputs.chunkCount * k.chunkSpacingSeconds +
    k.queueAllowanceSeconds;
  // Rounded up to whole milliseconds, so fractional per-image seconds
  // never shorten a lifetime and the stored times are integers.
  const specUrlExpiresAt = Math.ceil(
    now + Math.max(makespan * k.marginFactor, k.urlFloorSeconds) * 1000,
  );
  const tokenExpiresAt = Math.ceil(
    Math.max(
      specUrlExpiresAt + (longestJobSeconds + k.callbackTailSeconds) * 1000,
      now + k.tokenFloorSeconds * 1000,
    ),
  );
  return { specUrlExpiresAt, tokenExpiresAt };
}

// @version v0.8.0
