/**
 * Tests — no app code writes `users.is_platform_admin`
 *
 * This suite checks that no app code writes `users.is_platform_admin`, a
 * flag set only by the operator command
 * `scripts/commands/set-platform-admin.ts`. It is a meta-grep: it reads
 * every source file under `app/` as a raw string (`import.meta.glob` with
 * `?raw`, the only file-loading path the Workers pool allows) and fails on
 * anything that could write the column:
 *
 *   - the SQL name `is_platform_admin` on any code line other than the
 *     reviewed sites in `SQL_NAME_SITES` (comment lines may name it);
 *   - `isPlatformAdmin` inside the argument of a Drizzle `.set(`,
 *     `.values(` or `onConflictDoUpdate(` call;
 *   - a computed key (`[`) inside the argument of a users `.set(` or
 *     `.values(`, which could name the column without spelling it;
 *   - the Drizzle column `users.isPlatformAdmin` (bare, or interpolated
 *     into a `sql` template as `${users.isPlatformAdmin}`) on any code
 *     line other than the reviewed reads in `COLUMN_REF_SITES`;
 *   - an argument of `.update(users).set(` or `.insert(users).values(`
 *     that is not an object literal (an identifier, a call, anything
 *     that could carry the key unseen), or an object literal holding a
 *     spread, unless the file is in `NON_LITERAL_USERS_WRITES`, the list
 *     of reviewed sites;
 *   - `isPlatformAdmin` among the role flags the users screens write,
 *     or `is_platform_admin` among the columns `columnOf`
 *     (`app/lib/access-changes.server.ts`) maps them to.
 *
 * Each scanner is checked against fixtures it must flag and against the
 * real sites it must find, so a regex that stops matching fails here
 * rather than passing quietly. A reviewed site that is not found fails
 * too.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { users } from "../../app/db/schema";

const appFiles = import.meta.glob("../../app/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const sources = Object.entries(appFiles).filter(([path]) => !/\.test\.tsx?$/.test(path));

/**
 * Reviewed code lines that name `is_platform_admin`. Each is a read or
 * the column definition, never a write.
 */
const SQL_NAME_SITES: Array<{ file: string; line: RegExp; why: string }> = [
  {
    file: "app/db/schema.ts",
    line: /integer\("is_platform_admin"/,
    why: "the column definition",
  },
  {
    file: "app/lib/access-changes.server.ts",
    line: /EXISTS \(SELECT 1 FROM users WHERE .*is_platform_admin = 0/,
    why: "the last-admin rule reads the flag to leave platform admins out of the count",
  },
  {
    file: "app/lib/capture/scanner.server.ts",
    line: /"SELECT email, locale FROM users WHERE \(tenant_id = \? OR is_platform_admin = 1\)/,
    why: "the scanner keys notice reads the flag to find the operators to mail",
  },
];

/**
 * Reviewed code lines that name the Drizzle column `users.isPlatformAdmin`.
 * Each reads it, in a select or a where clause; none writes it. A line
 * matches a site only when every reference on it is one of the site's
 * `reads`: removing them leaves no `users.isPlatformAdmin` on the line.
 */
const COLUMN_REF_SITES: Array<{ file: string; reads: RegExp; why: string }> = [
  {
    file: "app/lib/platform-admin.server.ts",
    reads: /\.select\(\{ isPlatformAdmin: users\.isPlatformAdmin \}\)/g,
    why: "readIsPlatformAdmin reads the flag for one person",
  },
  {
    file: "app/lib/users-area.server.ts",
    reads: /\beq\(users\.isPlatformAdmin, (true|false)\)/g,
    why: "the users list separates platform admins from the workspace's people",
  },
  {
    file: "app/routes/_auth.admin.users.$id.tsx",
    reads: /\beq\(users\.isPlatformAdmin, false\)/g,
    why: "the detail page resolves its target only among people without the flag",
  },
];

const COLUMN_REF = /\busers\.isPlatformAdmin\b/;

function isReviewedRead(site: (typeof COLUMN_REF_SITES)[number], path: string, line: string): boolean {
  if (!path.endsWith(site.file)) return false;
  const rest = line.replace(site.reads, "");
  return rest !== line && !COLUMN_REF.test(rest);
}

/**
 * Reviewed `.update(users).set(...)` / `.insert(users).values(...)`
 * sites whose argument is not a plain object literal. None today: every
 * users write in app/ names its columns in a literal.
 */
const NON_LITERAL_USERS_WRITES: Array<{ file: string; why: string }> = [];

/** The text of the call whose opening parenthesis is at `open`, parentheses balanced. */
function callArgument(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

function calls(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(pattern)) {
    out.push(callArgument(text, (m.index ?? 0) + m[0].length - 1));
  }
  return out;
}

const DRIZZLE_WRITE = /\.(set|values|onConflictDoUpdate)\s*\(/g;
const USERS_UPDATE_SET = /\.update\(\s*(?:schema\.)?users\s*\)\s*\.set\s*\(/g;
const USERS_INSERT_VALUES = /\.insert\(\s*(?:schema\.)?users\s*\)\s*\.values\s*\(/g;

/** Code lines naming the SQL column, with the reviewed site each matches (or none). */
function sqlNameLines(path: string, text: string) {
  const out: Array<{ at: string; site: (typeof SQL_NAME_SITES)[number] | undefined }> = [];
  text.split("\n").forEach((line, i) => {
    if (!line.includes("is_platform_admin")) return;
    // A comment line cannot write; prose may name the column.
    if (/^\s*(\*|\/\*|\/\/)/.test(line)) return;
    const site = SQL_NAME_SITES.find((s) => path.endsWith(s.file) && s.line.test(line));
    out.push({ at: `${path}:${i + 1}: ${line.trim()}`, site });
  });
  return out;
}

/** Drizzle write arguments that carry `isPlatformAdmin`. */
function drizzleWritesOfFlag(text: string): string[] {
  return calls(text, DRIZZLE_WRITE).filter((arg) => arg.includes("isPlatformAdmin"));
}

/** Code lines naming `users.isPlatformAdmin`, with the reviewed site each matches (or none). */
function columnRefLines(path: string, text: string) {
  const out: Array<{ at: string; site: (typeof COLUMN_REF_SITES)[number] | undefined }> = [];
  text.split("\n").forEach((line, i) => {
    if (!COLUMN_REF.test(line)) return;
    if (/^\s*(\*|\/\*|\/\/)/.test(line)) return;
    if (path.endsWith("app/db/schema.ts")) return;
    const site = COLUMN_REF_SITES.find((s) => isReviewedRead(s, path, line));
    out.push({ at: `${path}:${i + 1}: ${line.trim()}`, site });
  });
  return out;
}

/** Users write arguments holding a computed key. */
function computedKeyUsersWrites(text: string): string[] {
  return [...calls(text, USERS_UPDATE_SET), ...calls(text, USERS_INSERT_VALUES)].filter((arg) =>
    /(^|[{,])\s*\[/.test(arg.trim()),
  );
}

/** Users write arguments that are not a spread-free object literal. */
function nonLiteralUsersWrites(text: string): string[] {
  return [...calls(text, USERS_UPDATE_SET), ...calls(text, USERS_INSERT_VALUES)].filter((arg) => {
    const a = arg.trim();
    return !a.startsWith("{") || a.includes("...");
  });
}

describe("the scanners find what they look for", () => {
  it("flag their fixtures", () => {
    expect(sqlNameLines("app/x.ts", "db.exec(`UPDATE users SET is_platform_admin = 1`);").filter((l) => !l.site)).toHaveLength(1);
    expect(sqlNameLines("app/x.ts", " * prose naming is_platform_admin")).toHaveLength(0);
    expect(drizzleWritesOfFlag("db.update(users).set({ isPlatformAdmin: true })")).toHaveLength(1);
    expect(drizzleWritesOfFlag("db.insert(users).values({ id, isPlatformAdmin: true })")).toHaveLength(1);
    expect(drizzleWritesOfFlag("x.onConflictDoUpdate({ set: { isPlatformAdmin: true } })")).toHaveLength(1);
    expect(nonLiteralUsersWrites("db.update(users).set(patch).where(x)")).toHaveLength(1);
    expect(nonLiteralUsersWrites("db.update(schema.users).set(buildPatch(form))")).toHaveLength(1);
    expect(nonLiteralUsersWrites("db.insert(users).values(row)")).toHaveLength(1);
    expect(nonLiteralUsersWrites("db.update(users).set({ ...form, name })")).toHaveLength(1);
    expect(nonLiteralUsersWrites("db.update(users).set({ name, updatedAt: now })")).toHaveLength(0);
    expect(computedKeyUsersWrites("db.update(users).set({ [users.isPlatformAdmin.name]: true })")).toHaveLength(1);
    expect(computedKeyUsersWrites("db.update(users).set({ name, [column]: 1 })")).toHaveLength(1);
    expect(computedKeyUsersWrites("db.insert(users).values({\n  id,\n  [key]: value,\n})")).toHaveLength(1);
    expect(computedKeyUsersWrites("db.update(users).set({ tags: [a, b] })")).toHaveLength(0);
    expect(
      columnRefLines("app/x.ts", "await db.run(sql`UPDATE users SET ${users.isPlatformAdmin} = 1`);").filter((l) => !l.site),
    ).toHaveLength(1);
    expect(columnRefLines("app/x.ts", "const col = users.isPlatformAdmin;").filter((l) => !l.site)).toHaveLength(1);
    expect(
      columnRefLines("app/lib/users-area.server.ts", "    .where(eq(users.isPlatformAdmin, true))").filter((l) => !l.site),
    ).toHaveLength(0);
    expect(
      columnRefLines(
        "app/lib/users-area.server.ts",
        "    .where(sql`${users.isPlatformAdmin} = 1`, eq(users.isPlatformAdmin, true))",
      ).filter((l) => !l.site),
    ).toHaveLength(1);
  });

  it("find the real sites", () => {
    let updates = 0;
    let inserts = 0;
    let writes = 0;
    for (const [, text] of sources) {
      updates += calls(text, USERS_UPDATE_SET).length;
      inserts += calls(text, USERS_INSERT_VALUES).length;
      writes += calls(text, DRIZZLE_WRITE).length;
    }
    // users updates: the middleware's lastActiveAt, the handoff's GitHub
    // bind, the detail page's profile, and the settings page's three.
    expect(updates).toBeGreaterThanOrEqual(6);
    // users inserts: invitations (two) and the operator's new workspace.
    expect(inserts).toBeGreaterThanOrEqual(3);
    expect(writes).toBeGreaterThan(100);
  });

  it("find every reviewed site, so none is left on the lists unseen", () => {
    for (const site of SQL_NAME_SITES) {
      const found = sources.some(([path, text]) => sqlNameLines(path, text).some((l) => l.site === site));
      expect(found, `${site.file}: ${site.why}`).toBe(true);
    }
    for (const site of COLUMN_REF_SITES) {
      const found = sources.some(([path, text]) => columnRefLines(path, text).some((l) => l.site === site));
      expect(found, `${site.file}: ${site.why}`).toBe(true);
    }
    for (const site of NON_LITERAL_USERS_WRITES) {
      const found = sources.some(([path, text]) => path.endsWith(site.file) && nonLiteralUsersWrites(text).length > 0);
      expect(found, `${site.file}: ${site.why}`).toBe(true);
    }
  });
});

describe("no app code writes is_platform_admin", () => {
  it("reads a non-trivial set of app sources", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some(([p]) => p.endsWith("app/middleware/auth.server.ts"))).toBe(true);
  });

  it("names the SQL column only at the reviewed sites", () => {
    const offenders: string[] = [];
    for (const [path, text] of sources) {
      for (const l of sqlNameLines(path, text)) if (!l.site) offenders.push(l.at);
    }
    expect(offenders).toEqual([]);
  });

  it("never passes isPlatformAdmin to a Drizzle write", () => {
    const offenders: string[] = [];
    for (const [path, text] of sources) {
      for (const arg of drizzleWritesOfFlag(text)) offenders.push(`${path}: ${arg.slice(0, 120)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("names the Drizzle column only at the reviewed reads", () => {
    const offenders: string[] = [];
    for (const [path, text] of sources) {
      for (const l of columnRefLines(path, text)) if (!l.site) offenders.push(l.at);
    }
    expect(offenders).toEqual([]);
  });

  it("passes no computed key to a users update or insert", () => {
    const offenders: string[] = [];
    for (const [path, text] of sources) {
      for (const arg of computedKeyUsersWrites(text)) offenders.push(`${path}: ${arg.slice(0, 120)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("passes only spread-free object literals to users updates and inserts, outside the reviewed sites", () => {
    const offenders: string[] = [];
    for (const [path, text] of sources) {
      if (NON_LITERAL_USERS_WRITES.some((s) => path.endsWith(s.file))) continue;
      for (const arg of nonLiteralUsersWrites(text)) offenders.push(`${path}: ${arg.slice(0, 120)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the flag out of the role flags and out of the columns columnOf maps them to", async () => {
    const { ROLE_FLAGS } = await import("../../app/lib/permissions.server");
    expect(ROLE_FLAGS).toContain("isSuperAdmin");
    expect(ROLE_FLAGS as readonly string[]).not.toContain("isPlatformAdmin");
    // columnOf(flag) is users[flag].name, over RoleFlag = ROLE_FLAGS.
    const columns = ROLE_FLAGS.map((flag) => users[flag].name);
    expect(columns).toContain("is_super_admin");
    expect(columns).not.toContain("is_platform_admin");
  });
});

// @version v0.9.0
