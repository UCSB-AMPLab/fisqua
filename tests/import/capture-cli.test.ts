/**
 * Tests — the arguments and input of `fisqua capture`
 *
 * This suite pins what the capture noun takes on the command line and
 * how it reads a file, for its three verbs, with the flags the three
 * commands it replaces took, mapped onto the noun's shape:
 *
 *   - `qc-decisions`: the list as the file, `--target`, `--tenant` and
 *     `--actor-email` required (they were `--source-record`, `--tenant`
 *     and `--decided-by`), `--revise` off by default; no other flag;
 *   - `register`: the manifest as the file, `--target` staging or
 *     production, `--tenant` and `--actor-email` required,
 *     `--allow-captured` off by default and refused against production;
 *   - `copy-renamed`: the rename map as the file, `--tenant` required,
 *     `--source-record` production by default or staging, and no
 *     `--target`;
 *   - every verb: `plan` or `apply`, `--confirm-production` read and
 *     left to the verb's run to check, a flag of another verb refused,
 *     a missing value and a missing file refused;
 *   - the input: a file that is not valid UTF-8 refused before it is
 *     parsed, a BOM dropped, and a JSON file that does not parse
 *     refused whole with the error the verb names;
 *   - a platform admin: admitted by `readCaptureAccess` exactly when the
 *     app's own test (`admitsAsPlatformAdmin`) admits them, from another
 *     tenant and without a federation membership, and not when the flag
 *     is off, their row is on the platform tenant or the tenant is not
 *     of kind `tenant`; the guards fail when the flag is lost or the
 *     tenant's kind changes between the plan and the apply;
 *   - the lead's admin: the workspace admin of the lead tenant of the
 *     tenant's federation is admitted to a member, with no grant and so
 *     no `edit_on_behalf` row, and recorded as acting as the lead's
 *     admin; a user of the lead who is not its admin, and an admin of
 *     another member, are refused; the guards fail when the admin role
 *     is lost or the federation's lead changes between the plan and the
 *     apply.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { parseCaptureArgs, readCaptureJson } from "../../scripts/lib/capture-cli/run";
import { RegistrationStop } from "../../scripts/lib/capture-registration";
import { readCaptureAccess } from "../../scripts/lib/qc-decisions";
import { ACTOR_MESSAGE, CAPTURE_TENANT_MESSAGE, captureAccessGuards } from "../../scripts/lib/cli/access-guards";
import { admitsAsPlatformAdmin } from "../../app/lib/platform-admin.server";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import { d1Read } from "./d1-limits";

const QC = ["capture", "qc-decisions", "plan", "l.tsv", "--target", "staging", "--tenant", "ahr", "--actor-email", "someone@example.com"];
const REG = ["capture", "register", "plan", "m.json", "--target", "staging", "--tenant", "sbmal", "--actor-email", "someone@example.com"];
const COPY = ["capture", "copy-renamed", "plan", "map.json", "--tenant", "sbmal"];

describe("capture qc-decisions arguments", () => {
  it("reads the file, target, tenant, actor and --revise", () => {
    expect(parseCaptureArgs(QC)).toEqual({
      verb: "qc-decisions",
      command: "plan",
      file: "l.tsv",
      target: "staging",
      tenant: "ahr",
      actorEmail: "someone@example.com",
      revise: false,
      confirmProduction: false,
    });
    expect(parseCaptureArgs([...QC, "--revise"])).toMatchObject({ revise: true });
    const apply = ["capture", "qc-decisions", "apply", ...QC.slice(3), "--target", "production", "--confirm-production"];
    expect(parseCaptureArgs(apply)).toMatchObject({ command: "apply", target: "production", confirmProduction: true });
  });

  it("refuses a missing file, tenant, actor or target, another target and any other flag", () => {
    expect(() => parseCaptureArgs(["capture", "qc-decisions", "plan", "--target", "staging", "--tenant", "ahr", "--actor-email", "x@example.com"])).toThrow(
      "capture qc-decisions needs a file",
    );
    expect(() => parseCaptureArgs(QC.filter((a, i) => i < 6 || i > 7))).toThrow("--tenant <slug> is required");
    expect(() => parseCaptureArgs(QC.slice(0, 8))).toThrow("--actor-email is required");
    expect(() => parseCaptureArgs(["capture", "qc-decisions", "plan", "l.tsv", "--tenant", "ahr", "--actor-email", "x@example.com"])).toThrow(
      "--target is staging or production",
    );
    expect(() => parseCaptureArgs([...QC, "--target", "local"])).toThrow("--target is staging or production");
    expect(() => parseCaptureArgs([...QC, "--force"])).toThrow("Unknown argument: --force");
    expect(() => parseCaptureArgs([...QC, "--allow-captured"])).toThrow("Unknown argument: --allow-captured");
    expect(() => parseCaptureArgs([...QC, "--source-record", "staging"])).toThrow("Unknown argument: --source-record");
    expect(() => parseCaptureArgs([...QC, "--decided-by", "x@example.com"])).toThrow("Unknown argument: --decided-by");
    expect(() => parseCaptureArgs(["capture", "qc-decisions", "record", "l.tsv"])).toThrow("capture qc-decisions takes plan or apply");
  });
});

describe("capture register arguments", () => {
  it("reads staging and production, --allow-captured on staging only", () => {
    for (const target of ["staging", "production"] as const) {
      expect(parseCaptureArgs([...REG, "--target", target])).toMatchObject({ verb: "register", target, command: "plan", allowCaptured: false });
    }
    expect(parseCaptureArgs([...REG, "--allow-captured"])).toMatchObject({ allowCaptured: true });
    expect(() => parseCaptureArgs([...REG, "--target", "production", "--allow-captured"])).toThrow(/refused against production/);
    expect(parseCaptureArgs([...REG, "--target", "production", "--confirm-production"])).toMatchObject({ confirmProduction: true });
  });

  it("refuses a missing manifest, another target and any other flag", () => {
    expect(() => parseCaptureArgs(["capture", "register", "plan", "--target", "staging", "--tenant", "sbmal", "--actor-email", "x@example.com"])).toThrow(
      /needs a file/,
    );
    expect(() => parseCaptureArgs([...REG, "--target", "remote"])).toThrow(/--target is staging or production/);
    expect(() => parseCaptureArgs([...REG, "--target", "local"])).toThrow(/--target is staging or production/);
    expect(() => parseCaptureArgs([...REG, "--force"])).toThrow(/Unknown argument/);
    expect(() => parseCaptureArgs([...REG, "--revise"])).toThrow(/Unknown argument/);
    expect(() => parseCaptureArgs(REG.slice(0, 8))).toThrow("--actor-email is required");
  });
});

describe("capture copy-renamed arguments", () => {
  it("reads the map, the tenant and --source-record, production by default", () => {
    expect(parseCaptureArgs(COPY)).toEqual({
      verb: "copy-renamed",
      command: "plan",
      file: "map.json",
      tenant: "sbmal",
      sourceRecord: "production",
      confirmProduction: false,
    });
    expect(parseCaptureArgs([...COPY, "--source-record", "staging"])).toMatchObject({ sourceRecord: "staging" });
    expect(parseCaptureArgs(["capture", "copy-renamed", "apply", "map.json", "--tenant", "sbmal", "--confirm-production"])).toMatchObject({
      command: "apply",
      confirmProduction: true,
    });
  });

  it("refuses another source record, a missing map or tenant, and --target", () => {
    expect(() => parseCaptureArgs([...COPY, "--source-record", "local"])).toThrow(/production or staging/);
    expect(() => parseCaptureArgs(["capture", "copy-renamed", "plan", "--tenant", "sbmal"])).toThrow(/needs a file/);
    expect(() => parseCaptureArgs(["capture", "copy-renamed", "plan", "map.json"])).toThrow(/--tenant <slug> is required/);
    expect(() => parseCaptureArgs([...COPY, "--target", "production"])).toThrow(/Unknown argument/);
    expect(() => parseCaptureArgs([...COPY, "--actor-email", "x@example.com"])).toThrow(/Unknown argument/);
  });
});

describe("the capture noun", () => {
  it("refuses an unknown verb", () => {
    expect(() => parseCaptureArgs(["capture", "rename", "plan", "x"])).toThrow(/Usage/);
    expect(() => parseCaptureArgs(["capture"])).toThrow(/Usage/);
  });
});

describe("reading a capture file", () => {
  const stop = (m: string) => new RegistrationStop(m);

  it("refuses a file that is not valid UTF-8 before it is parsed", () => {
    const latin1 = Buffer.concat([Buffer.from('{"note": "c'), Buffer.from([0xe9]), Buffer.from('dula"}')]);
    expect(() => readCaptureJson("m.json", "capture manifest", stop, () => latin1)).toThrow(/m\.json is not valid UTF-8/);
  });

  it("drops a BOM and parses the JSON", () => {
    expect(readCaptureJson("m.json", "capture manifest", stop, () => Buffer.from('﻿{"a": "cédula"}'))).toEqual({ a: "cédula" });
  });

  it("refuses a file that is not JSON whole, naming the file", () => {
    let err: unknown;
    try {
      readCaptureJson("m.json", "rename map", stop, () => Buffer.from("not json"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RegistrationStop);
    expect((err as Error).message).toMatch(/^The rename map m\.json is not readable JSON/);
  });
});

describe("a platform admin", () => {
  const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
  const OTHER = "22222222-bbbb-4bbb-8bbb-222222222222";
  const FED = "fed-acme";
  const EMAIL = "platform@example.test";

  /** Tenants, a federation and one user with no federation membership, with the columns the capture check reads. */
  function database(opts: { flag: number; home: string; kind: string }): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT, status TEXT);
      CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, kind TEXT NOT NULL DEFAULT 'tenant', federation_id TEXT, status TEXT,
        disabled_at INTEGER, digitization_enabled INTEGER DEFAULT 0);
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, tenant_id TEXT, is_admin INTEGER DEFAULT 0,
        is_super_admin INTEGER DEFAULT 0, is_digitization_admin INTEGER DEFAULT 0, is_platform_admin INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE federation_memberships (id TEXT PRIMARY KEY, user_id TEXT, federation_id TEXT, role TEXT);`);
    db.prepare("INSERT INTO federations VALUES (?, 'acme', 'active')").run(FED);
    const tenant = db.prepare("INSERT INTO tenants (id, slug, kind, federation_id, status, digitization_enabled) VALUES (?, ?, ?, ?, 'active', 1)");
    tenant.run(TENANT, "sbmal", opts.kind, FED);
    tenant.run(OTHER, "other", "tenant", FED);
    tenant.run(PLATFORM_TENANT_ID, "platform", "platform", null);
    db.prepare("INSERT INTO users (id, email, name, tenant_id, is_platform_admin) VALUES ('user-p', ?, 'Platform Admin', ?, ?)").run(
      EMAIL,
      opts.home,
      opts.flag,
    );
    return db;
  }

  const admitted = async (db: DatabaseSync) => {
    try {
      return await readCaptureAccess(async (q) => d1Read(db, q), "sbmal", EMAIL);
    } catch {
      return null;
    }
  };

  it("is admitted exactly when the app admits them, from another tenant and without a membership", async () => {
    const cases = [
      { flag: 1, home: OTHER, kind: "tenant" },
      { flag: 1, home: TENANT, kind: "tenant" },
      { flag: 0, home: OTHER, kind: "tenant" },
      { flag: 1, home: PLATFORM_TENANT_ID, kind: "tenant" },
      { flag: 1, home: OTHER, kind: "platform" },
    ];
    const results: Array<[boolean, boolean]> = [];
    for (const c of cases) {
      const app = admitsAsPlatformAdmin({ isPlatformAdmin: Number(c.flag) === 1, tenantId: c.home }, { kind: c.kind as "tenant" | "platform", disabledAt: null });
      const got = await admitted(database(c));
      results.push([got !== null, app]);
      // Admitted as a home member: no grant, so no edit_on_behalf row.
      if (got) expect(got.decider).toMatchObject({ grantHome: null, grantRole: null });
    }
    expect(results.map(([got]) => got)).toEqual(results.map(([, app]) => app));
    expect(results.map(([, app]) => app)).toEqual([true, true, false, false, false]);
  });

  /** The guards a plan for `opts` opens its file with that fail once `change` has run. */
  async function failingGuards(change: string): Promise<string[]> {
    const db = database({ flag: 1, home: OTHER, kind: "tenant" });
    const read = await admitted(db);
    expect(read).not.toBeNull();
    const guards = captureAccessGuards(read!.access);
    db.exec(change);
    return guards
      .filter((g) => {
        try {
          db.prepare(g).all();
          return false;
        } catch {
          return true;
        }
      })
      .map((g) => /'ABORT: ((?:[^']|'')*)'/.exec(g)![1].replace(/''/g, "'"));
  }

  it("guards the flag and the tenant's kind as read", async () => {
    expect(await failingGuards("SELECT 1")).toEqual([]);
    expect(await failingGuards("UPDATE users SET is_platform_admin = 0 WHERE id = 'user-p'")).toEqual([ACTOR_MESSAGE]);
    expect(await failingGuards(`UPDATE tenants SET kind = 'platform' WHERE id = '${TENANT}'`)).toEqual([CAPTURE_TENANT_MESSAGE]);
  });
});

describe("the lead's admin", () => {
  const LEAD = "33333333-cccc-4ccc-8ccc-333333333333";
  const MEMBER = "44444444-dddd-4ddd-8ddd-444444444444";
  const THIRD = "55555555-eeee-4eee-8eee-555555555555";
  const FED = "fed-neo";

  /** A federation led by `neogranadina`, with the members `ahr` and `third`, and three users without memberships. */
  function database(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT, status TEXT, lead_tenant_id TEXT);
      CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, kind TEXT NOT NULL DEFAULT 'tenant', federation_id TEXT, status TEXT,
        disabled_at INTEGER, digitization_enabled INTEGER DEFAULT 0);
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, tenant_id TEXT, is_admin INTEGER DEFAULT 0,
        is_super_admin INTEGER DEFAULT 0, is_digitization_admin INTEGER DEFAULT 0, is_platform_admin INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE federation_memberships (id TEXT PRIMARY KEY, user_id TEXT, federation_id TEXT, role TEXT);`);
    db.prepare("INSERT INTO federations VALUES (?, 'neogranadina', 'active', ?)").run(FED, LEAD);
    const tenant = db.prepare("INSERT INTO tenants (id, slug, federation_id, status, digitization_enabled) VALUES (?, ?, ?, 'active', 1)");
    tenant.run(LEAD, "neogranadina", FED);
    tenant.run(MEMBER, "ahr", FED);
    tenant.run(THIRD, "third", FED);
    const user = db.prepare("INSERT INTO users (id, email, name, tenant_id, is_admin, is_digitization_admin) VALUES (?, ?, ?, ?, ?, ?)");
    user.run("user-lead-admin", "lead-admin@example.test", "Lead Admin", LEAD, 1, 0);
    user.run("user-lead-digit", "lead-digit@example.test", "Lead Digitizer", LEAD, 0, 1);
    user.run("user-third-admin", "third-admin@example.test", "Third Admin", THIRD, 1, 0);
    return db;
  }
  const read = (db: DatabaseSync, email: string) => readCaptureAccess(async (q) => d1Read(db, q), "ahr", email);

  it("admits the lead's admin to a member, with no grant, as the lead's admin", async () => {
    const got = await read(database(), "lead-admin@example.test");
    expect(got.tenantId).toBe(MEMBER);
    expect(got.decider).toMatchObject({ id: "user-lead-admin", grantHome: null, grantRole: null, actedAs: "lead-admin" });
  });

  it("refuses a user of the lead who is not its admin, and an admin of another member", async () => {
    await expect(read(database(), "lead-digit@example.test")).rejects.toThrow(
      /lead-digit@example.test is not a user of ahr, has no steward or staff grant into it, and is not an admin of the lead workspace of its federation/,
    );
    await expect(read(database(), "third-admin@example.test")).rejects.toThrow(/third-admin@example.test is not a user of ahr/);
  });

  it("refuses the lead's admin while the federation is suspended, or on a suspended member", async () => {
    const fed = database();
    fed.exec(`UPDATE federations SET status = 'suspended' WHERE id = '${FED}'`);
    await expect(read(fed, "lead-admin@example.test")).rejects.toThrow(/is not a user of ahr/);
    const member = database();
    member.exec(`UPDATE tenants SET status = 'suspended' WHERE id = '${MEMBER}'`);
    await expect(read(member, "lead-admin@example.test")).rejects.toThrow(/is not a user of ahr/);
  });

  async function failingGuards(change: string): Promise<string[]> {
    const db = database();
    const got = await read(db, "lead-admin@example.test");
    const guards = captureAccessGuards(got.access);
    db.exec(change);
    return guards
      .filter((g) => {
        try {
          db.prepare(g).all();
          return false;
        } catch {
          return true;
        }
      })
      .map((g) => /'ABORT: ((?:[^']|'')*)'/.exec(g)![1].replace(/''/g, "'"));
  }

  it("guards the admin role, the federation's lead and the lead tenant as read", async () => {
    expect(await failingGuards("SELECT 1")).toEqual([]);
    expect(await failingGuards("UPDATE users SET is_admin = 0 WHERE id = 'user-lead-admin'")).toEqual([ACTOR_MESSAGE]);
    expect(await failingGuards(`UPDATE federations SET lead_tenant_id = '${THIRD}' WHERE id = '${FED}'`)).toEqual([CAPTURE_TENANT_MESSAGE]);
    expect(await failingGuards(`UPDATE tenants SET disabled_at = 1 WHERE id = '${LEAD}'`)).toEqual([ACTOR_MESSAGE]);
  });
});

// @version v0.9.0
