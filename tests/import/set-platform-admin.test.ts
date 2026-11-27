/**
 * Tests — the operator command that sets or clears a platform admin
 *
 * This suite pins `scripts/commands/set-platform-admin.ts` and its lib
 * `scripts/lib/platform-admin.ts`. The database is an in-memory SQLite
 * with stand-in `tenants` and `users` tables (the users table carries
 * the column migration 0114 adds, applied from the real file) and the
 * real audit log of migrations 0037 and 0108. Nothing here reaches D1
 * or a shell.
 *
 *   - set: flips `is_platform_admin` to 1 for the person with the email
 *     (matched without regard to case), and records one `set_user_role`
 *     audit row naming the flag and the step, with the platform tenant
 *     as the actor's tenant and the person as the target;
 *   - clear: flips it back to 0 with its own row;
 *   - a person already in the wanted state is left, with no row;
 *   - an unknown email stops the command;
 *   - a dry run reads and writes nothing;
 *   - a row changed between the read and the write, its flag or its
 *     email, is left as it was, with no audit row, and the command
 *     stops naming the audit row id to check; both statements are
 *     guarded on the email, and the re-read checks id, email and flag;
 *   - setting the flag on an operator (a row stored on the platform
 *     tenant) is refused;
 *   - the SQL file is removed once applied;
 *   - the arguments: the subcommand first, `--email`, `--target`, and
 *     `--confirm-production` for `--apply` against production.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ProvisionStop } from "../../scripts/lib/tenant-storage";
import {
  runSetPlatformAdmin,
  type SetPlatformAdminOptions,
  type SetPlatformAdminProviders,
} from "../../scripts/lib/platform-admin";
import { parseArgs } from "../../scripts/commands/set-platform-admin";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";

const NOW = 1_800_000_000_000;
const sql = (name: string) => readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL)");
  db.exec(
    "CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id), " +
      "email TEXT NOT NULL UNIQUE, is_admin INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)",
  );
  db.exec(sql("0114_users_platform_admin.sql"));
  db.exec(sql("0037_audit_log.sql"));
  db.exec(sql("0108_audit_user_access.sql"));
  db.prepare("INSERT INTO tenants (id) VALUES (?), (?)").run(PLATFORM_TENANT_ID, "t-home");
  db.prepare("INSERT INTO users (id, tenant_id, email) VALUES (?, ?, ?)").run("u-1", "t-home", "pa@example.test");
  return db;
}

function setup(opts: { beforeApply?: (db: DatabaseSync) => void } = {}) {
  const db = database();
  const files = new Map<string, string>();
  const removed: string[] = [];
  let n = 0;
  const providers: SetPlatformAdminProviders = {
    rows: async (q) => db.prepare(q).all() as Record<string, unknown>[],
    writeFile: (path, text) => files.set(path, text),
    applyFile: (path) => {
      opts.beforeApply?.(db);
      db.exec(files.get(path) as string);
    },
    removeFile: (path) => {
      files.delete(path);
      removed.push(path);
    },
    now: () => NOW,
    newId: () => `audit-${++n}`,
  };
  const lines: string[] = [];
  return { db, providers, files, removed, lines, log: (l: string) => lines.push(l) };
}

const options = (o: Partial<SetPlatformAdminOptions> = {}): SetPlatformAdminOptions => ({
  action: "set",
  email: "pa@example.test",
  target: "staging",
  apply: true,
  ...o,
});

const flag = (db: DatabaseSync) =>
  (db.prepare("SELECT is_platform_admin AS v FROM users WHERE id = 'u-1'").get() as { v: number }).v;
const audits = (db: DatabaseSync) => db.prepare("SELECT * FROM audit_log ORDER BY created_at, id").all();

async function stopped(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProvisionStop) return err.message;
    throw err;
  }
  throw new Error("expected the command to stop");
}

describe("set and clear", () => {
  it("sets the flag and records one audit row", async () => {
    const w = setup();
    const result = await runSetPlatformAdmin(options({ email: "PA@Example.TEST " }), w.providers, w.log);
    expect(result).toMatchObject({ step: "set", applied: true, userId: "u-1" });
    expect(flag(w.db)).toBe(1);
    expect(audits(w.db)).toEqual([
      {
        id: "audit-1",
        created_at: NOW,
        actor_user_id: null,
        actor_user_id_text: "set-platform-admin",
        actor_tenant_id: PLATFORM_TENANT_ID,
        action: "set_user_role",
        target_tenant_id: null,
        target_object_kind: "user",
        target_object_id: "u-1",
        impersonation_session_id: null,
        details: JSON.stringify({ flag: "isPlatformAdmin", step: "granted" }),
      },
    ]);
    // The stored tenant is not touched.
    expect(w.db.prepare("SELECT tenant_id FROM users WHERE id = 'u-1'").get()).toEqual({ tenant_id: "t-home" });
    expect(w.removed).toHaveLength(1);
    expect(w.files.size).toBe(0);
  });

  it("clears the flag with its own row", async () => {
    const w = setup();
    await runSetPlatformAdmin(options(), w.providers, w.log);
    const result = await runSetPlatformAdmin(options({ action: "clear" }), w.providers, w.log);
    expect(result).toMatchObject({ step: "clear", applied: true });
    expect(flag(w.db)).toBe(0);
    const rows = audits(w.db) as Array<{ details: string }>;
    expect(rows.map((r) => JSON.parse(r.details).step)).toEqual(["granted", "revoked"]);
  });

  it("leaves a person already in the wanted state, with no row", async () => {
    const w = setup();
    const result = await runSetPlatformAdmin(options({ action: "clear" }), w.providers, w.log);
    expect(result).toMatchObject({ step: "none", applied: false });
    expect(audits(w.db)).toEqual([]);
  });

  it("stops on an unknown email", async () => {
    const w = setup();
    expect(await stopped(runSetPlatformAdmin(options({ email: "nobody@example.test" }), w.providers, w.log))).toMatch(
      /No user has the email nobody@example.test/,
    );
  });

  it("writes nothing on a dry run", async () => {
    const w = setup();
    const result = await runSetPlatformAdmin(options({ apply: false }), w.providers, w.log);
    expect(result).toMatchObject({ step: "set", applied: false });
    expect(flag(w.db)).toBe(0);
    expect(audits(w.db)).toEqual([]);
    expect(w.files.size).toBe(0);
    expect(w.lines.join("\n")).toMatch(/would set/);
  });

  it("leaves a row changed between the read and the write, with no audit row", async () => {
    const w = setup({ beforeApply: (db) => db.exec("UPDATE users SET is_platform_admin = 1 WHERE id = 'u-1'") });
    const message = await stopped(runSetPlatformAdmin(options(), w.providers, w.log));
    expect(message).toMatch(/changed between the read and the write/);
    // The message names the audit row to check.
    expect(message).toMatch(/audit row audit-1 may need correcting/);
    expect(audits(w.db)).toEqual([]);
  });

  it("writes nothing when the row's email changed between the read and the write", async () => {
    const w = setup({
      beforeApply: (db) => db.exec("UPDATE users SET email = 'someone-else@example.test' WHERE id = 'u-1'"),
    });
    const message = await stopped(runSetPlatformAdmin(options(), w.providers, w.log));
    expect(message).toMatch(/audit row audit-1/);
    expect(flag(w.db)).toBe(0);
    expect(audits(w.db)).toEqual([]);
  });

  it("guards both statements on the email and the re-read on id, email and flag", async () => {
    const w = setup();
    const applied: string[] = [];
    const reads: string[] = [];
    const rows = w.providers.rows;
    w.providers.writeFile = (path, text) => {
      applied.push(text);
      w.files.set(path, text);
    };
    w.providers.rows = async (q) => {
      reads.push(q);
      return rows(q);
    };
    await runSetPlatformAdmin(options({ email: "PA@Example.TEST" }), w.providers, w.log);
    const [statements] = applied;
    const [insert, update] = statements.trim().split("\n");
    expect(insert).toMatch(/^INSERT INTO audit_log/);
    expect(insert).toContain("lower(email) = 'pa@example.test'");
    expect(update).toMatch(/^UPDATE users SET is_platform_admin = 1/);
    expect(update).toContain("lower(email) = 'pa@example.test'");
    const reread = reads[reads.length - 1];
    expect(reread).toContain("id = 'u-1'");
    expect(reread).toContain("lower(email) = 'pa@example.test'");
    expect(reread).toContain("is_platform_admin = 1");
  });

  it("refuses to set the flag on an operator, a row stored on the platform tenant", async () => {
    const w = setup();
    w.db.prepare("INSERT INTO users (id, tenant_id, email) VALUES (?, ?, ?)").run("u-op", PLATFORM_TENANT_ID, "op@example.test");
    expect(await stopped(runSetPlatformAdmin(options({ email: "op@example.test" }), w.providers, w.log))).toMatch(
      /stored on the platform tenant/,
    );
    expect(audits(w.db)).toEqual([]);
    expect(w.db.prepare("SELECT is_platform_admin AS v FROM users WHERE id = 'u-op'").get()).toEqual({ v: 0 });
  });
});

describe("arguments", () => {
  it("takes the subcommand first, the email and the target", () => {
    expect(parseArgs(["set", "--email", "pa@example.test", "--target", "staging"])).toEqual({
      action: "set",
      email: "pa@example.test",
      target: "staging",
      apply: false,
      confirmProduction: false,
    });
    expect(parseArgs(["clear", "--email", "pa@example.test", "--target", "staging", "--apply"]).apply).toBe(true);
  });

  it("refuses a missing subcommand, email or target", () => {
    expect(() => parseArgs(["grant", "--email", "a@b.c", "--target", "staging"])).toThrow(/subcommand/);
    expect(() => parseArgs(["set", "--target", "staging"])).toThrow(/--email/);
    expect(() => parseArgs(["set", "--email", "a@b.c"])).toThrow(/--target/);
    expect(() => parseArgs(["set", "--email", "a@b.c", "--target", "local"])).toThrow(/--target/);
    expect(() => parseArgs(["set", "--email", "a@b.c", "--target", "staging", "--force"])).toThrow(/Unknown argument/);
  });

  it("needs --confirm-production for --apply against production", () => {
    expect(() => parseArgs(["set", "--email", "a@b.c", "--target", "production", "--apply"])).toThrow(
      /--confirm-production/,
    );
    expect(
      parseArgs(["set", "--email", "a@b.c", "--target", "production", "--apply", "--confirm-production"]).confirmProduction,
    ).toBe(true);
    // A dry run against production needs no confirmation.
    expect(parseArgs(["set", "--email", "a@b.c", "--target", "production"]).apply).toBe(false);
  });
});

// @version v0.9.0
