/**
 * Test helper — run one migration file
 *
 * This module deals with executing a real file from `drizzle/` against
 * the test D1 database, so a migration's SQL is tested under the same
 * engine and the same defensive mode it will meet in production rather
 * than through the hand-built schema in `db.ts`. It reads the file as
 * raw text at build time, removes whole-line comments, splits on
 * Drizzle's `--> statement-breakpoint` marker, and runs each statement
 * on its own, which is how `wrangler d1 migrations apply` sends them.
 *
 * Trigger bodies keep their inner semicolons because each statement is
 * prepared whole rather than split on `;`.
 *
 * @version v0.8.0
 */
import { env } from "cloudflare:test";

const FILES = import.meta.glob("../../drizzle/*.sql", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

export function migrationStatements(name: string): string[] {
  const key = Object.keys(FILES).find((k) => k.endsWith(`/${name}`));
  if (!key) throw new Error(`No migration file named ${name}`);
  return FILES[key]
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

export async function runMigrationFile(name: string): Promise<void> {
  for (const statement of migrationStatements(name)) {
    await env.DB.prepare(statement).run();
  }
}
