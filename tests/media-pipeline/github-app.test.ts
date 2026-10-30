/**
 * Tests — media pipeline GitHub App token
 *
 * This suite drives `github-app.server.ts` with an RSA key pair
 * generated in the test and a stub `fetch` standing in for GitHub. It
 * pins:
 *
 *   - the JWT: its RS256 header, its claims (`iss` the App id, `iat` a
 *     minute back, `exp` nine minutes ahead) and a signature the public
 *     key verifies;
 *   - the private key: PKCS#1 and PKCS#8 PEMs both import and sign, the
 *     PKCS#1 wrapping gives the PKCS#8 bytes WebCrypto exports, a PEM
 *     with literal `\n` escapes or CRLF line endings imports, and
 *     anything else fails at the `private_key` step;
 *   - the token exchange: the endpoint, headers and body, narrowed to the
 *     runner repository's name with `contents: write`; a refusal, a
 *     network error and a malformed answer each fail naming the step and
 *     the status, with no secret in the message;
 *   - the answer: a 201 whose body is not an object with a non-empty
 *     token and a parseable expiry (`null` included) fails at
 *     `token_response`, and a refusal whose body cannot be cancelled
 *     still fails at `token_exchange` with its status;
 *   - the caches: one exchange while the token has more than five
 *     minutes left, and a new one once it has five minutes or less; one
 *     import per private key, and none kept when it fails.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  GitHubAppTokenError,
  JWT_BACKDATE_SECONDS,
  JWT_LIFETIME_SECONDS,
  TOKEN_REFRESH_MARGIN_MS,
  appPrivateKey,
  clearGitHubAppCaches,
  importAppPrivateKey,
  installationToken,
  pkcs1ToPkcs8,
  signAppJwt,
  type GitHubAppEnv,
} from "../../app/lib/pipeline/github-app.server";
import { githubAppTestKeys } from "../helpers/media-pipeline";

const APP_ID = "123456";
const INSTALLATION_ID = "7654321";
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function pemBytes(pem: string): Uint8Array {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

async function decodeJwt(jwt: string, publicKey: CryptoKey) {
  const [h, p, sig] = jwt.split(".");
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64urlDecode(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  return {
    header: JSON.parse(new TextDecoder().decode(base64urlDecode(h))),
    payload: JSON.parse(new TextDecoder().decode(base64urlDecode(p))),
    verified,
  };
}

async function appEnv(overrides: Partial<GitHubAppEnv> = {}): Promise<GitHubAppEnv> {
  return {
    PIPELINE_GITHUB_APP_ID: APP_ID,
    PIPELINE_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID,
    PIPELINE_GITHUB_APP_PRIVATE_KEY: (await githubAppTestKeys()).pkcs1Pem,
    PIPELINE_DISPATCH_REPO: "test-owner/test-runner",
    ...overrides,
  };
}

interface Exchange {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Answers exchange `n` with `reply(n)`; by default `token-{n}`, expiring an hour after `NOW`. */
function exchangeStub(
  reply: (n: number) => Response | "network" = (n) =>
    Response.json({ token: `token-${n}`, expires_at: new Date(NOW + 3_600_000).toISOString() }, { status: 201 }),
): { fetchImpl: typeof fetch; exchanges: Exchange[] } {
  const exchanges: Exchange[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    exchanges.push({
      url: String(input),
      method: String(init?.method),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    const r = reply(exchanges.length);
    if (r === "network") throw new TypeError("network error");
    return r;
  }) as typeof fetch;
  return { fetchImpl, exchanges };
}

async function stepOf(p: Promise<unknown>): Promise<GitHubAppTokenError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(GitHubAppTokenError);
    return err as GitHubAppTokenError;
  }
  throw new Error("expected a GitHubAppTokenError");
}

describe("the App's JWT", () => {
  it("is RS256 with the App id as iss, iat a minute back and exp nine minutes ahead, and verifies", async () => {
    const keys = await githubAppTestKeys();
    const key = await importAppPrivateKey(keys.pkcs1Pem);
    const jwt = await signAppJwt(key, APP_ID, NOW + 999);
    const { header, payload, verified } = await decodeJwt(jwt, keys.publicKey);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    const now = Math.floor(NOW / 1000);
    expect(payload).toEqual({
      iss: APP_ID,
      iat: now - JWT_BACKDATE_SECONDS,
      exp: now + JWT_LIFETIME_SECONDS,
    });
    expect(payload.iat).toBe(now - 60);
    expect(payload.exp).toBe(now + 540);
    expect(verified).toBe(true);
  });
});

describe("the App's private key", () => {
  it("imports from PKCS#1 and PKCS#8 PEMs, and both sign for the same public key", async () => {
    const keys = await githubAppTestKeys();
    expect(keys.pkcs1Pem).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(keys.pkcs8Pem).toContain("-----BEGIN PRIVATE KEY-----");
    for (const pem of [keys.pkcs1Pem, keys.pkcs8Pem]) {
      const jwt = await signAppJwt(await importAppPrivateKey(pem), APP_ID, NOW);
      expect((await decodeJwt(jwt, keys.publicKey)).verified).toBe(true);
    }
  });

  it("wraps PKCS#1 into the PKCS#8 bytes WebCrypto exports", async () => {
    const keys = await githubAppTestKeys();
    expect(pkcs1ToPkcs8(pemBytes(keys.pkcs1Pem))).toEqual(pemBytes(keys.pkcs8Pem));
  });

  it("imports a PEM with literal \\n escapes or CRLF line endings", async () => {
    const keys = await githubAppTestKeys();
    const escaped = keys.pkcs1Pem.replace(/\n/g, "\\n");
    expect(escaped).not.toContain("\n");
    const crlf = keys.pkcs1Pem.replace(/\n/g, "\r\n");
    const crlf8 = keys.pkcs8Pem.replace(/\n/g, "\r\n");
    for (const pem of [escaped, crlf, crlf8]) {
      const jwt = await signAppJwt(await importAppPrivateKey(pem), APP_ID, NOW);
      expect((await decodeJwt(jwt, keys.publicKey)).verified).toBe(true);
    }
  });

  it("fails at the private_key step for anything that is not an RSA private key PEM", async () => {
    const keys = await githubAppTestKeys();
    const mismatched = keys.pkcs1Pem.replace("END RSA PRIVATE KEY", "END PRIVATE KEY");
    const truncated = keys.pkcs8Pem.replace(/\n[^\n]+\n-----END/, "\n-----END");
    for (const pem of ["", "test-github-app-private-key", mismatched, truncated]) {
      const err = await stepOf(importAppPrivateKey(pem));
      expect(err.step).toBe("private_key");
      expect(err.status).toBeNull();
    }
  });
});

describe("appPrivateKey", () => {
  beforeEach(() => clearGitHubAppCaches());

  it("imports a PEM once per isolate and keeps no failed import", async () => {
    const keys = await githubAppTestKeys();
    const spy = vi.spyOn(crypto.subtle, "importKey");
    try {
      const a = await appPrivateKey(keys.pkcs1Pem);
      const b = await appPrivateKey(keys.pkcs1Pem);
      expect(b).toBe(a);
      expect(spy).toHaveBeenCalledTimes(1);
      await appPrivateKey(keys.pkcs8Pem);
      expect(spy).toHaveBeenCalledTimes(2);
      const broken = keys.pkcs8Pem.replace(/\n[^\n]+\n-----END/, "\n-----END");
      expect((await stepOf(appPrivateKey(broken))).step).toBe("private_key");
      expect((await stepOf(appPrivateKey(broken))).step).toBe("private_key");
      expect(spy).toHaveBeenCalledTimes(4);
      clearGitHubAppCaches();
      await appPrivateKey(keys.pkcs1Pem);
      expect(spy).toHaveBeenCalledTimes(5);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("installationToken", () => {
  beforeEach(() => clearGitHubAppCaches());

  it("exchanges a signed JWT for a token on the runner repository alone", async () => {
    const keys = await githubAppTestKeys();
    const { fetchImpl, exchanges } = exchangeStub();
    const token = await installationToken(await appEnv(), fetchImpl, NOW);
    expect(token).toBe("token-1");
    expect(exchanges).toHaveLength(1);
    const [x] = exchanges;
    expect(x.url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(x.method).toBe("POST");
    expect(x.headers.accept).toBe("application/vnd.github+json");
    expect(x.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(x.headers["user-agent"]).toBe("fisqua");
    expect(x.body).toEqual({ repositories: ["test-runner"], permissions: { contents: "write" } });
    const jwt = x.headers.authorization.replace(/^Bearer /, "");
    const { payload, verified } = await decodeJwt(jwt, keys.publicKey);
    expect(verified).toBe(true);
    expect(payload.iss).toBe(APP_ID);
  });

  it("accepts the PKCS#8 key as well", async () => {
    const keys = await githubAppTestKeys();
    const { fetchImpl } = exchangeStub();
    const env = await appEnv({ PIPELINE_GITHUB_APP_PRIVATE_KEY: keys.pkcs8Pem });
    expect(await installationToken(env, fetchImpl, NOW)).toBe("token-1");
  });

  it("fails at token_exchange naming the status when GitHub refuses, with no secret in the message", async () => {
    const keys = await githubAppTestKeys();
    for (const status of [401, 403, 404, 422, 500]) {
      clearGitHubAppCaches();
      const { fetchImpl, exchanges } = exchangeStub(
        () => Response.json({ message: "Bad credentials" }, { status }),
      );
      const err = await stepOf(installationToken(await appEnv(), fetchImpl, NOW));
      expect(err.step).toBe("token_exchange");
      expect(err.status).toBe(status);
      expect(err.message).toBe(`GitHub App token: token_exchange failed with HTTP ${status}`);
      const jwt = exchanges[0].headers.authorization.replace(/^Bearer /, "");
      for (const secret of [jwt, keys.pkcs1Pem, "Bad credentials"]) {
        expect(err.message).not.toContain(secret);
        expect(String(err.stack)).not.toContain(secret);
      }
    }
  });

  it("fails at token_exchange naming the status when the refusal's body cannot be cancelled", async () => {
    const broken = {
      status: 403,
      body: { cancel: () => Promise.reject(new Error("stream broke")) },
    } as unknown as Response;
    const { fetchImpl } = exchangeStub(() => broken);
    const err = await stepOf(installationToken(await appEnv(), fetchImpl, NOW));
    expect(err.step).toBe("token_exchange");
    expect(err.status).toBe(403);
  });

  it("fails at token_exchange with no status on a network error", async () => {
    const { fetchImpl } = exchangeStub(() => "network");
    const err = await stepOf(installationToken(await appEnv(), fetchImpl, NOW));
    expect(err.step).toBe("token_exchange");
    expect(err.status).toBeNull();
    expect(err.message).toBe("GitHub App token: token_exchange failed");
  });

  it("fails at token_response when a 201 carries no usable token", async () => {
    const bodies = [
      new Response("not json", { status: 201 }),
      new Response("null", { status: 201 }),
      Response.json([], { status: 201 }),
      Response.json("token", { status: 201 }),
      Response.json({ token: "", expires_at: new Date(NOW).toISOString() }, { status: 201 }),
      Response.json({ expires_at: new Date(NOW).toISOString() }, { status: 201 }),
      Response.json({ token: "t", expires_at: "soon" }, { status: 201 }),
    ];
    for (const body of bodies) {
      const { fetchImpl } = exchangeStub(() => body);
      const err = await stepOf(installationToken(await appEnv(), fetchImpl, NOW));
      expect(err.step).toBe("token_response");
      expect(err.status).toBe(201);
    }
  });

  it("fails before any request when the key does not import or the repository is not owner/name", async () => {
    const { fetchImpl, exchanges } = exchangeStub();
    const badKey = await stepOf(
      installationToken(await appEnv({ PIPELINE_GITHUB_APP_PRIVATE_KEY: "nope" }), fetchImpl, NOW),
    );
    expect(badKey.step).toBe("private_key");
    for (const repo of ["test-runner", "a/b/c", ""]) {
      const err = await stepOf(installationToken(await appEnv({ PIPELINE_DISPATCH_REPO: repo }), fetchImpl, NOW));
      expect(err.step).toBe("repository");
    }
    expect(exchanges).toEqual([]);
  });

  it("serves the cached token until five minutes before it expires, then exchanges again", async () => {
    const expiresAt = NOW + 3_600_000;
    const { fetchImpl, exchanges } = exchangeStub((n) =>
      Response.json(
        { token: `token-${n}`, expires_at: new Date(n === 1 ? expiresAt : expiresAt * 2).toISOString() },
        { status: 201 },
      ),
    );
    const env = await appEnv();
    expect(await installationToken(env, fetchImpl, NOW)).toBe("token-1");
    expect(await installationToken(env, fetchImpl, NOW + 60_000)).toBe("token-1");
    const edge = expiresAt - TOKEN_REFRESH_MARGIN_MS;
    expect(await installationToken(env, fetchImpl, edge - 1)).toBe("token-1");
    expect(exchanges).toHaveLength(1);
    expect(await installationToken(env, fetchImpl, edge)).toBe("token-2");
    expect(exchanges).toHaveLength(2);
    expect(await installationToken(env, fetchImpl, edge + 1)).toBe("token-2");
    expect(exchanges).toHaveLength(2);
  });

  it("keeps a token per runner repository", async () => {
    const { fetchImpl, exchanges } = exchangeStub();
    expect(await installationToken(await appEnv(), fetchImpl, NOW)).toBe("token-1");
    const other = await appEnv({ PIPELINE_DISPATCH_REPO: "test-owner/other-runner" });
    expect(await installationToken(other, fetchImpl, NOW)).toBe("token-2");
    expect(exchanges[1].body.repositories).toEqual(["other-runner"]);
  });
});

// @version v0.8.0
