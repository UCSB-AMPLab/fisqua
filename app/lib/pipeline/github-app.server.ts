/**
 * Media Pipeline — GitHub App Token
 *
 * This module deals with the credential dispatch presents to GitHub when
 * it asks the runner repository to start a run. Fisqua authenticates as
 * a GitHub App installed on the organization that owns the runner
 * repository, not as a person: the App's id, its installation id and
 * its private key are three secrets, and every dispatch carries a
 * short-lived installation token minted from them in the Worker.
 *
 * `installationToken` is the entry point. It returns a cached token
 * while it has more than five minutes left before its `expires_at`, and
 * otherwise mints a new one in two steps: it signs a JSON Web Token
 * (RS256, `iss` the App id, `iat` a minute in the past to allow for
 * clock drift, `exp` nine minutes ahead, inside GitHub's ten-minute
 * ceiling) with the private key, and posts it to the installation's
 * `access_tokens` endpoint, asking for `contents: write` on the runner
 * repository alone, the one named by `PIPELINE_DISPATCH_REPO`. That is
 * the permission `repository_dispatch` needs; the token reaches nothing
 * else the installation may cover. The cache lives in the isolate, so
 * each isolate exchanges at most once an hour or so.
 *
 * `appPrivateKey` imports the private key once per isolate for each PEM
 * it is given, and keeps the imported key; an import that fails is not
 * kept. Dispatch calls it when a run is started, before the run claims
 * any volume, so a key that will not import is refused there rather
 * than found at dispatch time. `clearGitHubAppCaches` empties both
 * caches, for tests.
 *
 * `importAppPrivateKey` reads the private key. GitHub issues it as a
 * PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`), and WebCrypto imports only
 * PKCS#8, so `pkcs1ToPkcs8` wraps the PKCS#1 bytes in the PKCS#8
 * structure (a version, the rsaEncryption algorithm identifier and the
 * key as an octet string); a PKCS#8 PEM (`BEGIN PRIVATE KEY`) is
 * imported as it is. The PEM is accepted with literal `\n` escapes or
 * CRLF line endings, which is how a multi-line secret often arrives.
 * `signAppJwt` builds and signs the JWT.
 *
 * Every failure is a `GitHubAppTokenError` naming its step
 * (`private_key`, `repository`, `jwt`, `token_exchange` or
 * `token_response`) and the HTTP status when there was one. A refusal's
 * body is cancelled on a best-effort basis, so a body stream that errors
 * cannot replace the error, and an answer is used only when it is a
 * JSON object with a non-empty `token` and a parseable `expires_at`.
 * Dispatch also catches anything else this module might throw and
 * records it as the step `unexpected`, with no message. Its message
 * is built from those two alone: the key, the JWT, the token and
 * GitHub's response body never appear in an error, and nothing here
 * logs.
 *
 * @version v0.8.0
 */

/** A cached token is replaced this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** How far back `iat` is set, for clock drift between the Worker and GitHub. */
export const JWT_BACKDATE_SECONDS = 60;
/** How long the JWT lives; GitHub refuses one longer than ten minutes. */
export const JWT_LIFETIME_SECONDS = 540;
/** How long the token exchange may take before it counts as failed. */
export const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

const GITHUB_API = "https://api.github.com";
const REPO_PATTERN = /^[^/\s]+\/([^/\s]+)$/;

/** The settings this module reads. */
export interface GitHubAppEnv {
  PIPELINE_GITHUB_APP_ID?: string;
  PIPELINE_GITHUB_APP_INSTALLATION_ID?: string;
  PIPELINE_GITHUB_APP_PRIVATE_KEY?: string;
  PIPELINE_DISPATCH_REPO?: string;
}

export type GitHubAppTokenStep =
  | "private_key"
  | "repository"
  | "jwt"
  | "token_exchange"
  | "token_response"
  // Set by dispatch for a failure this module did not name.
  | "unexpected";

/** A failure to mint an installation token. Carries no secret. */
export class GitHubAppTokenError extends Error {
  readonly step: GitHubAppTokenStep;
  readonly status: number | null;
  constructor(step: GitHubAppTokenStep, status: number | null = null) {
    super(
      status === null
        ? `GitHub App token: ${step} failed`
        : `GitHub App token: ${step} failed with HTTP ${status}`,
    );
    this.name = "GitHubAppTokenError";
    this.step = step;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// The private key
// ---------------------------------------------------------------------------

const PEM_PATTERN = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END \1PRIVATE KEY-----/;

/** The DER length octets for `n`. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derTlv(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const head = [tag, ...derLength(content.length)];
  const out = new Uint8Array(head.length + content.length);
  out.set(head, 0);
  out.set(content, head.length);
  return out;
}

// version 0, then AlgorithmIdentifier { rsaEncryption, NULL }.
const PKCS8_RSA_PREFIX = new Uint8Array([
  0x02, 0x01, 0x00,
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/** Wraps a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const key = derTlv(0x04, pkcs1);
  const body = new Uint8Array(PKCS8_RSA_PREFIX.length + key.length);
  body.set(PKCS8_RSA_PREFIX, 0);
  body.set(key, PKCS8_RSA_PREFIX.length);
  return derTlv(0x30, body);
}

/** Imports a PKCS#1 or PKCS#8 PEM as an RS256 signing key. */
export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  const text = pem.replace(/\\n/g, "\n").replace(/\r/g, "");
  const match = PEM_PATTERN.exec(text);
  if (!match) throw new GitHubAppTokenError("private_key");
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = Uint8Array.from(atob(match[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  } catch {
    throw new GitHubAppTokenError("private_key");
  }
  const pkcs8 = match[1] ? pkcs1ToPkcs8(der) : der;
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new GitHubAppTokenError("private_key");
  }
}

// ---------------------------------------------------------------------------
// The JWT
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Signs the App's JWT at `nowMs`. */
export async function signAppJwt(key: CryptoKey, appId: string, nowMs: number): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const signingInput = `${base64urlJson({ alg: "RS256", typ: "JWT" })}.${base64urlJson({
    iat: now - JWT_BACKDATE_SECONDS,
    exp: now + JWT_LIFETIME_SECONDS,
    iss: appId,
  })}`;
  try {
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${base64url(new Uint8Array(signature))}`;
  } catch {
    throw new GitHubAppTokenError("jwt");
  }
}

// ---------------------------------------------------------------------------
// The installation token
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const cache = new Map<string, CachedToken>();
const keyCache = new Map<string, Promise<CryptoKey>>();

/** Empties the isolate's token and key caches. */
export function clearGitHubAppCaches(): void {
  cache.clear();
  keyCache.clear();
}

/** The imported private key for `pem`, imported once per isolate. */
export function appPrivateKey(pem: string): Promise<CryptoKey> {
  let key = keyCache.get(pem);
  if (!key) {
    key = importAppPrivateKey(pem);
    keyCache.set(pem, key);
    key.catch(() => keyCache.delete(pem));
  }
  return key;
}

/**
 * An installation token for the runner repository, from the cache while
 * it has more than `TOKEN_REFRESH_MARGIN_MS` left at `nowMs`.
 */
export async function installationToken(
  env: GitHubAppEnv,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<string> {
  const appId = env.PIPELINE_GITHUB_APP_ID?.trim() ?? "";
  const installationId = env.PIPELINE_GITHUB_APP_INSTALLATION_ID?.trim() ?? "";
  const repoName = REPO_PATTERN.exec(env.PIPELINE_DISPATCH_REPO?.trim() ?? "")?.[1];
  if (!repoName) throw new GitHubAppTokenError("repository");

  const cacheKey = `${appId}:${installationId}:${repoName}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > nowMs) return cached.token;

  const key = await appPrivateKey(env.PIPELINE_GITHUB_APP_PRIVATE_KEY ?? "");
  const jwt = await signAppJwt(key, appId, nowMs);

  let res: Response;
  try {
    res = await fetchImpl(
      `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "fisqua",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repositories: [repoName],
          permissions: { contents: "write" },
        }),
        signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
      },
    );
  } catch {
    throw new GitHubAppTokenError("token_exchange");
  }
  if (res.status !== 201) {
    try {
      await res.body?.cancel();
    } catch {
      // The refusal is what matters; a body that fails to cancel is not.
    }
    throw new GitHubAppTokenError("token_exchange", res.status);
  }

  let parsed: CachedToken;
  try {
    parsed = tokenOf(await res.json());
  } catch {
    throw new GitHubAppTokenError("token_response", res.status);
  }
  cache.set(cacheKey, parsed);
  return parsed.token;
}

/** The token and its expiry from GitHub's answer; throws on anything else. */
function tokenOf(body: unknown): CachedToken {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TypeError("not an object");
  }
  const { token, expires_at } = body as Record<string, unknown>;
  const expiresAtMs = typeof expires_at === "string" ? Date.parse(expires_at) : NaN;
  if (typeof token !== "string" || token === "" || Number.isNaN(expiresAtMs)) {
    throw new TypeError("no usable token");
  }
  return { token, expiresAtMs };
}

// @version v0.8.0
