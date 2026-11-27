/**
 * Tests — EAD3 and Dublin Core files against pre-refactor golden output
 *
 * This suite holds the per-fonds EAD3 and Dublin Core files to the bytes
 * the single-string builders wrote before the publish steps began
 * writing these documents a batch at a time. The golden documents in
 * `ead-dc-golden.ts` were generated from that earlier tree, so unlike a
 * comparison of the batched path with today's `buildEad3`, a change to
 * either builder's output (an attribute added to `<dsc>`, an element
 * moved) fails here.
 *
 * The fixture fonds (`ead-dc-golden-fixture.ts`) is seeded into the test
 * D1 and written by `exportFondsEad` for the ISAD(G), DACS and RAD
 * profiles and by `exportFondsDc`, with the batch and part sizes cut
 * down so each file takes several batches and parts, and with the
 * default sizes. `buildEad3` and `buildDcBulk`, given the same rows,
 * must also match.
 *
 * The seed gives the test federation a hosting statement, so the Dublin
 * Core file shows that the publish step reads it into each repository's
 * attribution line.
 *
 * @version v0.9.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { exportFondsEad, exportFondsDc } from "../../app/lib/export/pipeline.server";
import { buildEad3 } from "../../app/lib/export/ead/builder";
import { buildDcBulk } from "../../app/lib/export/dc/builder";
import { getEadProfile } from "../../app/lib/export/ead/profiles/registry";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { EadInput, ExportTenant } from "../../app/lib/export/types";
import { repositoryAttribution } from "../../app/lib/export/attribution";
import { MemoryStorage } from "./memory-storage";
import { GOLDEN } from "./ead-dc-golden";
import {
  GOLDEN_CREATED,
  GOLDEN_FONDS,
  GOLDEN_HOSTING,
  GOLDEN_NOW,
  GOLDEN_ROOT,
  goldenRepositories,
  goldenRows,
} from "./ead-dc-golden-fixture";

const tenantFor = (standard: "isadg" | "dacs" | "rad"): ExportTenant => ({
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: "neogranadina",
  descriptiveStandard: standard,
});

async function seed() {
  const db = drizzle(env.DB, { schema });
  await env.DB.prepare("UPDATE federations SET hosting_statement_es = ?, hosting_statement_en = ? WHERE id = ?")
    .bind(GOLDEN_HOSTING.hostingStatementEs, GOLDEN_HOSTING.hostingStatementEn, DEFAULT_TEST_FEDERATION_ID)
    .run();
  for (const r of goldenRepositories) {
    await db.insert(schema.repositories).values({
      ...r, tenantId: DEFAULT_TEST_TENANT_ID, enabled: true, createdAt: GOLDEN_CREATED, updatedAt: GOLDEN_CREATED,
    });
  }
  for (const r of goldenRows) {
    await db.insert(schema.descriptions).values({
      ...r,
      legacyIds: r.legacyIds ?? "[]",
      tenantId: DEFAULT_TEST_TENANT_ID,
      rootDescriptionId: GOLDEN_ROOT,
      createdAt: GOLDEN_CREATED,
      updatedAt: GOLDEN_CREATED,
    });
  }
}

const SMALL = { batchSize: 2, partSize: 700, now: GOLDEN_NOW };

describe("EAD3 and Dublin Core files match the pre-refactor golden output", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seed();
  });

  for (const standard of ["isadg", "dacs", "rad"] as const) {
    it(`writes the golden EAD3 file for the ${standard} profile`, async () => {
      const db = drizzle(env.DB, { schema });
      for (const options of [SMALL, { now: GOLDEN_NOW }]) {
        const storage = new MemoryStorage();
        await exportFondsEad(db, storage as unknown as ExportStorage, GOLDEN_FONDS, tenantFor(standard), options);
        expect(storage.text(`neogranadina/ead/${GOLDEN_FONDS}.xml`)).toBe(GOLDEN[`ead_${standard}`]);
        if (options === SMALL) expect(storage.partSizes.length).toBeGreaterThan(2);
      }
    });
  }

  it("writes the golden Dublin Core file", async () => {
    const db = drizzle(env.DB, { schema });
    for (const options of [SMALL, { now: GOLDEN_NOW }]) {
      const storage = new MemoryStorage();
      await exportFondsDc(db, storage as unknown as ExportStorage, GOLDEN_FONDS, tenantFor("isadg"), options);
      expect(storage.text(`neogranadina/dc/${GOLDEN_FONDS}.xml`)).toBe(GOLDEN.dc);
    }
  });

  it("builds the golden documents with buildEad3 and buildDcBulk", () => {
    const rows: EadInput[] = goldenRows
      .filter((r) => r.isPublished)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((r) => ({
        id: r.id, referenceCode: r.referenceCode, title: r.title, descriptionLevel: r.descriptionLevel,
        dateExpression: r.dateExpression ?? null, extent: r.extent ?? null, creatorDisplay: r.creatorDisplay ?? null,
        scopeContent: r.scopeContent ?? null, accessConditions: r.accessConditions ?? null, language: r.language ?? null,
        placeDisplay: r.placeDisplay ?? null, imprint: r.imprint ?? null, parentReferenceCode: null,
        repositoryId: r.repositoryId, isPublished: true,
        // The rows' valid legacy ids, as the step parses them.
        legacyIds: r.referenceCode === GOLDEN_FONDS
          ? [{ provider: "ca", id: 7 }]
          : r.referenceCode === "co-g-s1-f1"
            ? [{ provider: "former-reference-code", id: "co-g-viejo-1" }]
            : null,
        adminBiogHistory: r.adminBiogHistory ?? null, preferredCitation: r.preferredCitation ?? null,
        acquisitionInfo: r.acquisitionInfo ?? null, systemOfArrangement: r.systemOfArrangement ?? null,
        physicalCharacteristics: r.physicalCharacteristics ?? null,
      }));
    const repos = new Map(
      goldenRepositories.map((r) => [
        r.id,
        {
          name: r.name,
          city: r.city ?? "",
          code: r.code,
          attribution: repositoryAttribution(
            {
              name: r.name,
              city: r.city,
              region: r.region ?? null,
              country: r.country ?? null,
              // The fixture rows take the column's default code.
              countryCode: "COL",
              manifestRights: r.manifestRights ?? null,
              creditStatementEs: r.creditStatementEs ?? null,
              creditStatementEn: r.creditStatementEn ?? null,
              attributionEs: null,
              attributionEn: null,
            },
            GOLDEN_HOSTING,
          ),
        },
      ])
    );
    for (const standard of ["isadg", "dacs", "rad"] as const) {
      expect(buildEad3(rows, repos, getEadProfile(standard), GOLDEN_NOW.toISOString())).toBe(GOLDEN[`ead_${standard}`]);
    }
    expect(buildDcBulk(rows, repos, GOLDEN_FONDS, GOLDEN_NOW.toISOString().slice(0, 10))).toBe(GOLDEN.dc);
  });
});

// @version v0.9.0
