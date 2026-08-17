/**
 * Drizzle Kit configuration
 *
 * Drizzle Kit is the command-line companion to the Drizzle ORM: it reads
 * the table definitions we write in TypeScript and works out what SQL is
 * needed to bring a database in line with them.
 *
 * This file tells it three things — where the table definitions live
 * (`app/db/schema.ts`), where to write the migration files it generates
 * (`drizzle/`), and which flavour of SQL to speak. The dialect is SQLite
 * because Cloudflare D1, the database behind every workspace, is SQLite
 * underneath.
 *
 * Generated migrations are numbered and committed; they are applied with
 * `wrangler d1 migrations apply`, never by Drizzle Kit pushing directly
 * at a live database.
 *
 * @version v0.2.0
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./app/db/schema.ts",
  dialect: "sqlite",
});
