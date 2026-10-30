/**
 * Tests — media pipeline run token
 *
 * This suite pins the per-run bearer token the runner presents on its
 * callbacks, and the two lifetimes computed when a run starts: how long
 * the presigned spec URL stays valid, and how long the token does.
 *
 *   - minting gives an `fpr_` token of 43 base64url characters and the
 *     SHA-256 of the whole token as 64 lowercase hex characters;
 *   - `parseBearer` accepts only `Bearer <token>` with one space and a
 *     well-formed token;
 *   - verification hashes exactly once on every path, compares the hash
 *     before it looks at expiry, and so answers `invalid` rather than
 *     `expired` to a caller without the right token;
 *   - nothing in the module writes the token to the console;
 *   - the lifetimes grow with run size, respect both floors, and always
 *     leave the token alive for at least the longest job plus the
 *     callback tail after the URL has expired.
 *
 * The lifetime constants are injected, so these cases hold whatever
 * values are settled for production.
 *
 * @version v0.8.0
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mintRunToken,
  hashRunToken,
  parseBearer,
  verifyRunToken,
  runLifetimes,
  assertLifetimeConstants,
  PRESIGN_MAX_SECONDS,
  type LifetimeConstants,
  type LifetimeInputs,
} from "../../app/lib/pipeline/token.server";

const TOKEN_RE = /^fpr_[A-Za-z0-9_-]{43}$/;
const NOW = Date.UTC(2026, 10, 2, 14, 0, 0);
const FUTURE = NOW + 3_600_000;
const PAST = NOW - 1;

const BASE: LifetimeConstants = {
  secondsPerImage: 1,
  perJobOverheadSeconds: 60,
  lanes: 16,
  chunkSpacingSeconds: 30,
  queueAllowanceSeconds: 600,
  marginFactor: 1.5,
  tokenFloorSeconds: 7_200,
  urlFloorSeconds: 3_600,
  callbackTailSeconds: 600,
};

function jobSeconds(images: number, k: LifetimeConstants): number {
  return images * k.secondsPerImage + k.perJobOverheadSeconds;
}

function makespan(inputs: LifetimeInputs, k: LifetimeConstants): number {
  const jobs = inputs.jobImageCounts.map((n) => jobSeconds(n, k));
  const longest = Math.max(...jobs);
  const total = jobs.reduce((a, b) => a + b, 0);
  return (
    Math.max(longest, total / k.lanes) +
    inputs.chunkCount * k.chunkSpacingSeconds +
    k.queueAllowanceSeconds
  );
}

function longestJob(inputs: LifetimeInputs, k: LifetimeConstants): number {
  return Math.max(...inputs.jobImageCounts.map((n) => jobSeconds(n, k)));
}

function run(jobImageCounts: number[], chunkCount = 1): LifetimeInputs {
  return {
    totalImages: jobImageCounts.reduce((a, b) => a + b, 0),
    jobImageCounts,
    chunkCount,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mintRunToken and hashRunToken", () => {
  it("mints a well-formed token and its hex hash; two mints differ", async () => {
    const a = await mintRunToken();
    const b = await mintRunToken();
    expect(a.token).toMatch(TOKEN_RE);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.token).not.toBe(a.token);
    expect(b.hash).not.toBe(a.hash);
  });

  it("hashes the full token string to the minted hash", async () => {
    const minted = await mintRunToken();
    expect(await hashRunToken(minted.token)).toBe(minted.hash);
  });
});

describe("verifyRunToken", () => {
  it("accepts the right token before expiry and refuses one changed character", async () => {
    const minted = await mintRunToken();
    const stored = { hash: minted.hash, expiresAt: FUTURE };
    expect(await verifyRunToken(stored, minted.token, NOW)).toBe("ok");
    const last = minted.token.at(-1)!;
    const changed = minted.token.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(await verifyRunToken(stored, changed, NOW)).toBe("invalid");
  });

  it("refuses when no run is stored, hashing exactly once as on the wrong-token path", async () => {
    const minted = await mintRunToken();
    const digest = vi.spyOn(crypto.subtle, "digest");
    expect(await verifyRunToken(null, minted.token, NOW)).toBe("invalid");
    expect(digest).toHaveBeenCalledTimes(1);

    digest.mockClear();
    const other = await mintRunToken();
    digest.mockClear();
    expect(
      await verifyRunToken({ hash: other.hash, expiresAt: FUTURE }, minted.token, NOW),
    ).toBe("invalid");
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it("hashes once when no token is presented", async () => {
    const minted = await mintRunToken();
    const digest = vi.spyOn(crypto.subtle, "digest");
    expect(await verifyRunToken({ hash: minted.hash, expiresAt: FUTURE }, null, NOW)).toBe(
      "invalid",
    );
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it("answers invalid, not expired, to a wrong token on an expired run", async () => {
    const minted = await mintRunToken();
    const other = await mintRunToken();
    expect(
      await verifyRunToken({ hash: minted.hash, expiresAt: PAST }, other.token, NOW),
    ).toBe("invalid");
  });

  it("answers expired to the right token at and after expiry", async () => {
    const minted = await mintRunToken();
    expect(
      await verifyRunToken({ hash: minted.hash, expiresAt: NOW }, minted.token, NOW),
    ).toBe("expired");
    expect(
      await verifyRunToken({ hash: minted.hash, expiresAt: PAST }, minted.token, NOW),
    ).toBe("expired");
  });

  it("answers invalid when the stored hash is malformed", async () => {
    const minted = await mintRunToken();
    expect(
      await verifyRunToken({ hash: "not-hex", expiresAt: FUTURE }, minted.token, NOW),
    ).toBe("invalid");
  });
});

describe("parseBearer", () => {
  it("returns null for anything but one well-formed bearer token", async () => {
    const { token } = await mintRunToken();
    const body43 = token.slice(4);
    const cases: (string | null)[] = [
      null,
      "",
      "Bearer",
      "Basic abc",
      `Bearer  ${token}`,
      `Bearer fpr_${body43.slice(1)}`,
      `Bearer fpr_${body43.slice(1)}=`,
      `Bearer ${token}=`,
      `Bearer ${token} `,
      ` Bearer ${token}`,
      `Bearer ${body43}`,
    ];
    for (const header of cases) {
      expect(parseBearer(header)).toBeNull();
    }
  });

  it("accepts the scheme in any case", async () => {
    const { token } = await mintRunToken();
    expect(parseBearer(`Bearer ${token}`)).toBe(token);
    expect(parseBearer(`bearer ${token}`)).toBe(token);
    expect(parseBearer(`BEARER ${token}`)).toBe(token);
  });
});

describe("logging", () => {
  it("never writes the token to the console", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((m) => vi.spyOn(console, m));
    const minted = await mintRunToken();
    await hashRunToken(minted.token);
    parseBearer(`Bearer ${minted.token}`);
    parseBearer("Bearer garbage");
    await verifyRunToken({ hash: minted.hash, expiresAt: FUTURE }, minted.token, NOW);
    await verifyRunToken({ hash: minted.hash, expiresAt: PAST }, minted.token, NOW);
    await verifyRunToken(null, minted.token, NOW);
    runLifetimes(NOW, run([10]), BASE);
    assertLifetimeConstants(BASE);
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(minted.token);
      }
    }
  });
});

describe("runLifetimes", () => {
  it("is monotonic in image count and job count, and respects both floors", () => {
    let prev = runLifetimes(NOW, run([1]), BASE);
    for (const images of [2, 50, 734, 5_000, 50_000]) {
      const next = runLifetimes(NOW, run([images]), BASE);
      expect(next.specUrlExpiresAt).toBeGreaterThanOrEqual(prev.specUrlExpiresAt);
      expect(next.tokenExpiresAt).toBeGreaterThanOrEqual(prev.tokenExpiresAt);
      prev = next;
    }
    prev = runLifetimes(NOW, run([734]), BASE);
    for (const jobs of [2, 16, 17, 64, 256]) {
      const next = runLifetimes(NOW, run(Array(jobs).fill(734)), BASE);
      expect(next.specUrlExpiresAt).toBeGreaterThanOrEqual(prev.specUrlExpiresAt);
      expect(next.tokenExpiresAt).toBeGreaterThanOrEqual(prev.tokenExpiresAt);
      prev = next;
    }
    for (const counts of [[1], [2], [734], Array(256).fill(734)]) {
      const r = runLifetimes(NOW, run(counts), BASE);
      expect(r.tokenExpiresAt - NOW).toBeGreaterThanOrEqual(BASE.tokenFloorSeconds * 1000);
      expect(r.specUrlExpiresAt - NOW).toBeGreaterThanOrEqual(BASE.urlFloorSeconds * 1000);
    }
  });

  it("gives a full 256-job wave a URL that covers its completion job's start", () => {
    const constantsSet: LifetimeConstants[] = [
      BASE,
      { ...BASE, secondsPerImage: 0.95, lanes: 16, marginFactor: 1 },
      { ...BASE, secondsPerImage: 0.1, lanes: 4, perJobOverheadSeconds: 0, queueAllowanceSeconds: 0 },
      { ...BASE, secondsPerImage: 3, lanes: 1, urlFloorSeconds: 60, tokenFloorSeconds: 60 },
    ];
    for (const k of constantsSet) {
      const r = runLifetimes(NOW, run(Array(256).fill(734)), k);
      const bound = Math.ceil(256 / k.lanes) * 734 * k.secondsPerImage;
      expect((r.specUrlExpiresAt - NOW) / 1000).toBeGreaterThan(bound);
    }
  });

  it("keeps the presign cap at seven days", () => {
    expect(PRESIGN_MAX_SECONDS).toBe(604_800);
  });

  it("leaves the token alive for the longest job plus the callback tail after the URL expires", () => {
    const runs: LifetimeInputs[] = [
      run([2]),
      run([1]),
      run([734]),
      run([2, 2, 2, 2]),
      run(Array(256).fill(734)),
      run(Array(600).fill(120), 3),
      run([5_000, 2, 2], 1),
    ];
    const constantsSet: LifetimeConstants[] = [
      { ...BASE, tokenFloorSeconds: 1_800, urlFloorSeconds: 3_600 },
      { ...BASE, tokenFloorSeconds: 3_600, urlFloorSeconds: 3_600 },
      { ...BASE, tokenFloorSeconds: 14_400, urlFloorSeconds: 3_600 },
      { ...BASE, marginFactor: 1, callbackTailSeconds: 1 },
    ];
    for (const k of constantsSet) {
      for (const inputs of runs) {
        const r = runLifetimes(NOW, inputs, k);
        const span = makespan(inputs, k);
        const longest = longestJob(inputs, k);
        expect(r.specUrlExpiresAt).toBeGreaterThanOrEqual(NOW + span * k.marginFactor * 1000);
        expect(r.specUrlExpiresAt).toBeGreaterThanOrEqual(NOW + k.urlFloorSeconds * 1000);
        const gap = r.tokenExpiresAt - r.specUrlExpiresAt;
        expect(gap).toBeGreaterThanOrEqual((longest + k.callbackTailSeconds) * 1000);
        expect(gap).toBeGreaterThan(0);
      }
    }
  });

  it("puts a two-image sample run on the URL floor", () => {
    const k: LifetimeConstants = {
      ...BASE,
      secondsPerImage: 0.5,
      perJobOverheadSeconds: 10,
      chunkSpacingSeconds: 1,
      queueAllowanceSeconds: 5,
      marginFactor: 2,
      urlFloorSeconds: 3_600,
      tokenFloorSeconds: 7_200,
      callbackTailSeconds: 600,
    };
    const inputs = run([2]);
    const r = runLifetimes(NOW, inputs, k);
    expect(r.specUrlExpiresAt).toBe(NOW + k.urlFloorSeconds * 1000);
    const longest = longestJob(inputs, k);
    expect(r.tokenExpiresAt).toBe(
      Math.max(
        r.specUrlExpiresAt + (longest + k.callbackTailSeconds) * 1000,
        NOW + k.tokenFloorSeconds * 1000,
      ),
    );

    const lowFloor = { ...k, tokenFloorSeconds: 60 };
    const r2 = runLifetimes(NOW, inputs, lowFloor);
    expect(r2.tokenExpiresAt).toBe(
      r2.specUrlExpiresAt + (longest + k.callbackTailSeconds) * 1000,
    );
  });

  it("refuses constants with no callback tail", () => {
    expect(() => assertLifetimeConstants({ ...BASE, callbackTailSeconds: 0 })).toThrow();
    expect(() => runLifetimes(NOW, run([2]), { ...BASE, callbackTailSeconds: 0 })).toThrow();
  });
});

// @version v0.8.0
