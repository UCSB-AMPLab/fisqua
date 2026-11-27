/**
 * Scripts — what the authority merge commands share
 *
 * This module deals with the parts of a bulk authority merge that do not
 * depend on whether the records are places or entities: reading a D1
 * through wrangler, rendering Drizzle statements to SQL text, and the
 * guards that make a merge file fail whole when what it was planned from
 * has changed. The place command (`scripts/commands/place-merges.ts`)
 * and the entity command (`scripts/commands/entity-merges.ts`) both use
 * it; the merge statements themselves come from the composers in
 * `app/lib/pair-merge.server.ts`.
 *
 * Arguments: `parseMergeArgs` reads `--target local|staging|production`,
 * `--tenant <slug>`, `--list`, `--apply` and `--confirm-production`, and
 * refuses an apply to production without the last. The tenant is
 * required: a shared record carries links from several tenants'
 * descriptions, and a merge moves only the named tenant's.
 * `inTenantDescriptions` is the SQL condition that keeps a junction
 * read, and every link-count guard, to that tenant's descriptions.
 *
 * Reads: `query` runs one SELECT on the target (`wrangler d1 execute
 * --json --command`, through `runD1Json`, which runs a read again when D1
 * is overloaded); `typed` asks for each column with its SQLite type,
 * and `storedValue` turns the pair back into the stored value, so a NULL
 * and an empty string stay distinct on every target.
 *
 * Guards: each is a SELECT that returns 1 or fails on `json('ABORT: …')`
 * (`guard`, from `./cli/guard.ts`, re-exported here), and D1 applies a
 * `--file` as one unit, so a failing guard leaves nothing written.
 * `matchingGuards` checks that rows still hold the values read: it joins the table against a VALUES list on `IS` (NULL
 * matching NULL), which keeps the expression depth under D1's limit of
 * 100 however many rows are checked, and packs the rows into statements
 * of at most `STATEMENT_BUDGET` bytes. `oversizedStatements` lists any
 * statement of a finished file over that budget, which the commands
 * refuse.
 *
 * @version v0.9.0
 */

import { runD1, runD1Json } from "./d1-cli";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { escapeSql } from "./sql";
import { guard } from "./cli/guard";

export type Target = "local" | "staging" | "production";

/** Rows read per page: no more than a production read may ask for (`PRODUCTION_READ_CAP`). */
export const PAGE = 1_000;

/**
 * The largest statement the file may hold, in UTF-8 bytes: D1 refuses a
 * statement over 100 KB, and this leaves a margin.
 */
export const STATEMENT_BUDGET = 50_000;

export interface MergeArgs {
  target: Target;
  /** The slug of the tenant whose description links the merge moves. */
  tenant: string;
  apply: boolean;
  confirmProduction: boolean;
  list: string;
}

/** `--target`, `--tenant`, `--list`, `--apply` and `--confirm-production`, as both merge commands take them. */
export function parseMergeArgs(argv: string[], listName: string): MergeArgs {
  let target: Target | null = null;
  let tenant: string | null = null;
  let apply = false;
  let confirmProduction = false;
  let list: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--target") {
      const v = argv[++i];
      if (v !== "local" && v !== "staging" && v !== "production") {
        throw new Error(`--target must be local, staging or production; got ${v}`);
      }
      target = v;
    } else if (a === "--tenant") {
      tenant = argv[++i] ?? null;
      if (!tenant) throw new Error("--tenant needs a slug");
    } else if (a === "--list") {
      list = argv[++i] ?? null;
      if (!list) throw new Error("--list needs a path");
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (target === null) throw new Error("--target is required (local, staging or production)");
  if (tenant === null) throw new Error("--tenant <slug> is required");
  if (list === null) throw new Error(`--list <${listName}> is required`);
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("Applying to production also needs --confirm-production.");
  }
  return { target, tenant, apply, confirmProduction, list };
}

/**
 * The condition, on a junction table's `description_id`, that keeps a
 * read or a guard to one tenant's descriptions.
 */
export function inTenantDescriptions(tenantId: string): string {
  return `description_id IN (SELECT id FROM descriptions WHERE tenant_id = ${escapeSql(tenantId)})`;
}

export function wranglerArgs(target: Target): string[] {
  if (target === "local") return ["wrangler", "d1", "execute", "fisqua-db", "--local"];
  if (target === "staging") {
    return ["wrangler", "d1", "execute", "fisqua-staging-db", "--env", "staging", "--remote"];
  }
  return ["wrangler", "d1", "execute", "fisqua-db", "--remote"];
}

export function query<T>(target: Target, sql: string): T[] {
  const parsed = runD1Json<T>([...wranglerArgs(target), "--json", "--command", sql], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  });
  return parsed[0]?.results ?? [];
}

/** Apply one SQL file to the target, as one unit. */
export function applyFile(target: Target, sqlPath: string): void {
  runD1([...wranglerArgs(target), "--file", sqlPath, ...(target === "local" ? [] : ["--yes"])], {
    stdio: "inherit",
  });
}

/** Columns read with their SQLite type, so a NULL and an empty string stay distinct on every target. */
export function typed(columns: readonly string[]): string {
  return columns.map((c) => `${c}, typeof(${c}) AS ${c}__type`).join(", ");
}

/** The stored value: null for SQL NULL, a number for an integer or real, otherwise the text. */
export function storedValue(r: Record<string, unknown>, column: string): string | number | null {
  const type = r[`${column}__type`];
  if (type === "null") return null;
  if (type === "integer" || type === "real") return Number(r[column]);
  return String(r[column]);
}

/** A Drizzle database used only to compose statements; nothing is executed through it. */
export function composer(): DrizzleD1Database<any> {
  return drizzle({} as any);
}

/** Render one composed Drizzle statement as SQL text, its parameters inlined. */
export function render(builder: { toSQL(): { sql: string; params: unknown[] } }): string {
  const { sql, params } = builder.toSQL();
  let out = "";
  let i = 0;
  let quote: string | null = null;
  for (const ch of sql) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
    } else if (ch === "?") {
      if (i >= params.length) throw new Error(`more placeholders than parameters in: ${sql}`);
      out += escapeSql(params[i++]);
    } else out += ch;
  }
  if (i !== params.length) throw new Error(`more parameters than placeholders in: ${sql}`);
  return `${out};`;
}

// The guard statement lives in `./cli/guard.ts`, which loads without
// Node's child processes; it is re-exported here for the merge modules.
export { guard };

export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const idList = (ids: string[]) => ids.map(escapeSql).join(", ");

/**
 * The number of `table` rows matching one of `rows` on every column, NULL
 * matching NULL. The rows are a VALUES table joined on `IS`, so the
 * expression depth stays the same however many rows a guard checks; an OR
 * of per-row conditions exceeds D1's limit of 100. A column may be an
 * expression over the table's columns.
 */
function matching(table: string, columns: readonly string[], values: string[]): string {
  const on = columns
    .map((c, i) => `${/^[a-z_]+$/.test(c) ? `t.${c}` : c.replace(/\bname_variants\b/, "t.name_variants")} IS v.column${i + 1}`)
    .join(" AND ");
  return `(SELECT count(*) FROM ${table} t JOIN (VALUES ${values.join(", ")}) v ON ${on})`;
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * Guards that every one of `rows` still matches `table` on `columns`,
 * packed into as few statements as fit the byte budget. A row too long
 * to fit any statement gets one of its own, which the size check on the
 * finished file then refuses.
 */
export function matchingGuards(table: string, columns: readonly string[], rows: unknown[][], message: string): string[] {
  const out: string[] = [];
  const statement = (values: string[]) => guard(`${matching(table, columns, values)} = ${values.length}`, message);
  const overhead = bytes(statement(["(0)"])) + 16;
  let batch: string[] = [];
  let size = overhead;
  for (const r of rows) {
    const literal = `(${r.map(escapeSql).join(", ")})`;
    const add = bytes(literal) + 2;
    if (batch.length > 0 && size + add > STATEMENT_BUDGET) {
      out.push(statement(batch));
      batch = [];
      size = overhead;
    }
    batch.push(literal);
    size += add;
  }
  if (batch.length > 0) out.push(statement(batch));
  return out;
}

/** Statements of the file over the byte budget, by position. */
export function oversizedStatements(sql: string[]): Array<{ index: number; bytes: number; head: string }> {
  return sql
    .map((text, index) => ({ index, bytes: bytes(text), head: text.slice(0, 120) }))
    .filter((s) => s.bytes > STATEMENT_BUDGET);
}

// @version v0.9.0
