/**
 * Tests — the federation hosting read before migration 0122
 *
 * This suite deals with a pipeline run on a database that has not yet
 * applied migration 0122: the federation's hosting statement reads as
 * null, so the run composes the attribution without it instead of
 * failing on the missing columns. With the columns present, the stored
 * statement is read.
 *
 * @version v0.9.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { applyMigrations, DEFAULT_TEST_FEDERATION_ID } from "../helpers/db";
import { readFederationHosting } from "../../app/lib/pipeline/dispatch.server";

const db = () => drizzle(env.DB, { schema });

describe("the federation hosting read", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("reads the stored statement when migration 0122 is applied", async () => {
    await env.DB.prepare(
      "UPDATE federations SET hosting_statement_es = 'Alojado en X.', hosting_statement_en = 'Hosted on X.' WHERE id = ?",
    ).bind(DEFAULT_TEST_FEDERATION_ID).run();
    expect(await readFederationHosting(db(), DEFAULT_TEST_FEDERATION_ID)).toEqual({
      hostingStatementEs: "Alojado en X.",
      hostingStatementEn: "Hosted on X.",
    });
  });

  it("returns null, without failing, when the columns are missing", async () => {
    await env.DB.prepare("ALTER TABLE federations DROP COLUMN hosting_statement_es").run();
    await env.DB.prepare("ALTER TABLE federations DROP COLUMN hosting_statement_en").run();
    expect(await readFederationHosting(db(), DEFAULT_TEST_FEDERATION_ID)).toBeNull();
  });
});

// @version v0.9.0
