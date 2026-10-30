/**
 * Tests — making, replacing and revoking a capture unit's link token
 *
 * This suite pins the operator command that gives a tenant's Captua
 * unit its bearer token for the capture link. The tenant comes from the
 * in-memory providers of the storage commands, and the database is an
 * in-memory SQLite built from the real migrations that create the
 * scanner table (0093) and give it its revision (0101), behind stand-ins
 * for the tenants, users and pipeline volumes tables. Nothing
 * here reaches D1 or a shell.
 *
 *   - make: creates the scanner with a token, stores only its SHA-256,
 *     and prints the token once, after the write is read back; gives a
 *     token to a scanner whose token was revoked; refuses a scanner with
 *     a live token, and a name other than the scanner's;
 *   - replace: a new hash in place of the old, the old token's hash gone;
 *   - revoke: sets `revoked_at`, keeps the hash, and does nothing when
 *     there is no live token;
 *   - a dry run mints and writes nothing; a scanner changed between the
 *     read and the write is left as it was and no token is printed; the
 *     SQL file holds the hash and not the token, and is removed;
 *   - the statement written is the one the Scanner screen writes
 *     (`app/lib/capture/scanner-token.ts`), with its values as literals;
 *   - the arguments: the subcommand first, `--appliance` for make,
 *     `--confirm-production`.
 *
 * Every value here is a test value: no real tenant or token.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ProvisionStop } from "../../scripts/lib/tenant-storage";
import {
  inlineSql,
  runScannerToken,
  type ScannerTokenOptions,
  type ScannerTokenProviders,
} from "../../scripts/lib/scanner-token";
import { scannerTokenStatement } from "../../app/lib/capture/scanner-token";
import { parseArgs } from "../../scripts/commands/scanner-token";
import { hashScannerToken } from "../../app/lib/capture/token";
import { fakeWorld, FAKE_TENANT_ID } from "./tenant-storage-fakes";

const NOW = 1_800_000_000_000;

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL)");
  // 0093 adds a column to the pipeline volumes; a stand-in takes it.
  db.exec("CREATE TABLE pipeline_volumes (id TEXT PRIMARY KEY NOT NULL)");
  db.exec(readFileSync(fileURLToPath(new URL("../../drizzle/0093_capture_link.sql", import.meta.url)), "utf8"));
  // 0101 adds the scanner's revision and write id; it also rebuilds the
  // audit log, which 0037 creates over a stand-in users table.
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)");
  db.exec(readFileSync(fileURLToPath(new URL("../../drizzle/0037_audit_log.sql", import.meta.url)), "utf8"));
  db.exec(readFileSync(fileURLToPath(new URL("../../drizzle/0101_audit_scanner_token.sql", import.meta.url)), "utf8"));
  db.prepare("INSERT INTO tenants (id) VALUES (?)").run(FAKE_TENANT_ID);
  return db;
}

function setup(opts: { db?: DatabaseSync; beforeApply?: (db: DatabaseSync) => void } = {}) {
  const db = opts.db ?? database();
  const files = new Map<string, string>();
  const written: string[] = [];
  const removed: string[] = [];
  let n = 0;
  const providers: ScannerTokenProviders = {
    d1: fakeWorld().providers.d1,
    rows: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
    writeFile: (path, text) => {
      files.set(path, text);
      written.push(text);
    },
    applyFile: (path) => {
      opts.beforeApply?.(db);
      db.exec(files.get(path) as string);
    },
    removeFile: (path) => {
      files.delete(path);
      removed.push(path);
    },
    now: () => NOW + n,
    newId: () => `scanner-${++n}`,
  };
  const lines: string[] = [];
  return { db, providers, files, written, removed, lines, log: (l: string) => lines.push(l) };
}

const options = (o: Partial<ScannerTokenOptions> = {}): ScannerTokenOptions => ({
  action: "make",
  slug: "sbmal",
  appliance: "rig-1",
  target: "staging",
  apply: true,
  ...o,
});

const scanners = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM capture_scanners").all() as Array<Record<string, any>>;

async function stopped(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProvisionStop) return err.message;
    throw err;
  }
  throw new Error("expected the command to stop");
}

describe("make", () => {
  it("creates the scanner, stores only the token's hash and prints the token once", async () => {
    const w = setup();
    const result = await runScannerToken(options(), w.providers, w.log);
    const [row] = scanners(w.db);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(row).toMatchObject({ tenant_id: FAKE_TENANT_ID, name: "rig-1", revoked_at: null, token_created_at: NOW });
    expect(row.token_sha256).toBe(await hashScannerToken(result.token as string));
    expect(w.lines.filter((l) => l.includes(result.token as string))).toHaveLength(1);
    expect(w.written.join("")).not.toContain(result.token);
    expect(w.written.join("")).toContain(row.token_sha256);
    expect(w.removed).toHaveLength(1);
    expect(w.files.size).toBe(0);
  });

  it("refuses a scanner with a live token, and a name other than the scanner's", async () => {
    const w = setup();
    await runScannerToken(options(), w.providers, w.log);
    expect(await stopped(runScannerToken(options(), w.providers, w.log))).toMatch(/use replace/);
    expect(await stopped(runScannerToken(options({ appliance: "rig-2" }), w.providers, w.log))).toMatch(
      /scanner is rig-1, not rig-2/,
    );
  });

  it("gives a token again to a scanner whose token was revoked", async () => {
    const w = setup();
    const first = await runScannerToken(options(), w.providers, w.log);
    await runScannerToken(options({ action: "revoke", appliance: null }), w.providers, w.log);
    const again = await runScannerToken(options(), w.providers, w.log);
    const [row] = scanners(w.db);
    expect(again.step).toBe("issue");
    expect(row.revoked_at).toBeNull();
    expect(row.token_sha256).toBe(await hashScannerToken(again.token as string));
    expect(row.token_sha256).not.toBe(await hashScannerToken(first.token as string));
    expect(scanners(w.db)).toHaveLength(1);
  });

  it("needs --appliance", async () => {
    const w = setup();
    expect(await stopped(runScannerToken(options({ appliance: null }), w.providers, w.log))).toMatch(/--appliance/);
  });
});

describe("replace and revoke", () => {
  it("replace puts a new hash in place of the old", async () => {
    const w = setup();
    const first = await runScannerToken(options(), w.providers, w.log);
    const second = await runScannerToken(options({ action: "replace", appliance: null }), w.providers, w.log);
    const [row] = scanners(w.db);
    expect(second.token).not.toBe(first.token);
    expect(row.token_sha256).toBe(await hashScannerToken(second.token as string));
    expect(row.revoked_at).toBeNull();
  });

  it("replace needs a live token", async () => {
    const w = setup();
    expect(await stopped(runScannerToken(options({ action: "replace" }), w.providers, w.log))).toMatch(/use make/);
  });

  it("revoke sets revoked_at and keeps the hash; with no live token it does nothing", async () => {
    const w = setup();
    const made = await runScannerToken(options(), w.providers, w.log);
    const revoked = await runScannerToken(options({ action: "revoke", appliance: null }), w.providers, w.log);
    const [row] = scanners(w.db);
    expect(revoked.token).toBeUndefined();
    expect(row.revoked_at).not.toBeNull();
    expect(row.token_sha256).toBe(await hashScannerToken(made.token as string));
    const again = await runScannerToken(options({ action: "revoke", appliance: null }), w.providers, w.log);
    expect(again.step).toBe("none");
  });
});

describe("safety", () => {
  it("a dry run mints and writes nothing", async () => {
    const w = setup();
    const result = await runScannerToken(options({ apply: false }), w.providers, w.log);
    expect(result).toMatchObject({ step: "create", applied: false });
    expect(result.token).toBeUndefined();
    expect(w.written).toEqual([]);
    expect(scanners(w.db)).toEqual([]);
  });

  it("leaves a scanner changed between the read and the write, and prints no token", async () => {
    const w = setup({
      beforeApply: (db) => db.exec("UPDATE capture_scanners SET revoked_at = 1"),
    });
    await runScannerToken(options(), { ...w.providers, applyFile: (p) => w.db.exec(w.files.get(p) as string) }, w.log);
    const before = scanners(w.db)[0].token_sha256;
    w.lines.length = 0;
    const message = await stopped(runScannerToken(options({ action: "replace", appliance: null }), w.providers, w.log));
    expect(message).toMatch(/re-read does not show the write/);
    expect(scanners(w.db)[0].token_sha256).toBe(before);
    expect(w.lines.some((l) => /^ {2}[0-9a-f]{64}$/.test(l))).toBe(false);
    expect(w.files.size).toBe(0);
  });
});

describe("one path with the Scanner screen", () => {
  it("writes the statement the screen writes, with its values as literals", async () => {
    const w = setup();
    const minted = { token: "1".repeat(64), sha256: "2".repeat(64) };
    await runScannerToken(options(), { ...w.providers, mint: async () => minted }, w.log);
    const [row] = scanners(w.db);
    const expected = scannerTokenStatement("create", {
      tenantId: FAKE_TENANT_ID,
      current: null,
      newId: row.id,
      name: "rig-1",
      sha256: minted.sha256,
      now: row.created_at,
      writeId: row.write_id,
    });
    expect(row.revision).toBe(1);
    expect(w.written).toEqual([inlineSql(expected) + "\n"]);
  });

  it("writes values as SQL literals, quotes doubled, and refuses a count mismatch", () => {
    expect(inlineSql({ sql: "SELECT ?, ?, ?;", params: ["it's", 3, null] })).toBe("SELECT 'it''s', 3, NULL;");
    expect(() => inlineSql({ sql: "SELECT ?;", params: [] })).toThrow(/Placeholder/);
  });
});

describe("the arguments", () => {
  it("take the subcommand first and guard production", () => {
    expect(parseArgs(["make", "--tenant", "sbmal", "--appliance", "rig-1", "--target", "staging"])).toMatchObject({
      action: "make",
      tenant: "sbmal",
      appliance: "rig-1",
      apply: false,
    });
    expect(() => parseArgs(["--tenant", "sbmal"])).toThrow(/subcommand/);
    expect(() => parseArgs(["make", "--tenant", "sbmal", "--target", "staging"])).toThrow(/--appliance/);
    expect(() => parseArgs(["revoke", "--tenant", "sbmal", "--target", "production", "--apply"])).toThrow(
      /--confirm-production/,
    );
    expect(() => parseArgs(["revoke", "--tenant", "sbmal", "--target", "local"])).toThrow(/--target/);
    expect(() => parseArgs(["make", "--tenant", "sbmal", "--appliance", "Rig_1", "--target", "staging"])).toThrow(
      /Not an appliance id/,
    );
  });
});

// @version v0.8.0
