/**
 * Tests — the workspace export's ocrText column
 *
 * This suite covers the workspace export's `ocrText` column. The
 * ISAD(G) column list keeps `ocrText`, so the workspace export's
 * canonical CSV and JSON both carry it. The text is not taken from the
 * description row: each emitter reads the description's OCR page rows
 * and joins them in page order with a blank line between pages. These
 * cases pin that source for both emitters: the migrated page-1 row wins
 * over the column while the column still exists, pages written by a
 * pipeline run fill the cell in page order, a page row filed under
 * another tenant never reaches the file, and the header row is still
 * the ISAD(G) column list.
 *
 * The Workers pool rolls back each test's writes, so every test seeds
 * what it reads.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { seedOcrFixtures, seedPage, OCR_IDS } from "../helpers/ocr-fixtures";
import { resolveExportScope } from "../../app/lib/export/scopes.server";
import { emitCanonicalCsv } from "../../app/lib/export/canonical-csv.server";
import type { ExportEmitContext } from "../../app/lib/export/canonical-csv.server";
import { emitJson } from "../../app/lib/export/json.server";
import { generateCanonicalHeaders } from "../../app/lib/import/canonical-template";
import { decodeAndParseCsv } from "../../app/lib/import/csv";
import type { Tenant, User } from "../../app/context";

const ROOT = "0d000000-0000-4000-8000-0000000000f1";
const OWNER_ID = "8a300000-0000-4000-8000-000000000001";

const ctx: ExportEmitContext = { checkpoint: async () => {} };

function db() {
  return drizzle(env.DB, { schema });
}

const owner: User = {
  id: OWNER_ID,
  tenantId: OCR_IDS.tenantA,
  email: `${OWNER_ID}@test.local`,
  name: null,
  isAdmin: false,
  isSuperAdmin: false,
  isCollabAdmin: false,
  isArchiveUser: false,
  isUserManager: false,
  isCataloguer: false,
  isRecordsAdmin: false,
  isAuthoritiesAdmin: false,
  isImportsAdmin: false,
  isDigitizationAdmin: false,
  lastActiveAt: null,
  githubId: null,
};

async function loadTenant(id: string): Promise<Tenant> {
  const row = await db().select().from(schema.tenants).where(eq(schema.tenants.id, id)).get();
  if (!row) throw new Error(`tenant ${id} not seeded`);
  return row as Tenant;
}

async function setColumn(id: string, text: string): Promise<void> {
  const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('descriptions')").all<{ name: string }>();
  if (!cols.results.some((c) => c.name === "ocr_text")) return;
  await env.DB.prepare("UPDATE descriptions SET ocr_text = ? WHERE id = ?").bind(text, id).run();
}

beforeEach(async () => {
  await applyMigrations();
  await cleanDatabase();
  await seedOcrFixtures();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).bind(OWNER_ID, OCR_IDS.tenantA, `${OWNER_ID}@test.local`, 0, now, now).run();
  await env.DB.prepare(
    "INSERT INTO descriptions (id, tenant_id, repository_id, description_level, reference_code, title, created_at, updated_at) VALUES (?, ?, ?, 'fonds', 'pe-bn-cdip', 'Fondo', ?, ?)",
  ).bind(ROOT, OCR_IDS.tenantA, OCR_IDS.repoA, now, now).run();
  await env.DB.prepare(
    "UPDATE descriptions SET parent_id = ?, root_description_id = ? WHERE id IN (?, ?, ?)",
  ).bind(ROOT, ROOT, OCR_IDS.descA1, OCR_IDS.descA2, OCR_IDS.descA3).run();

  await setColumn(OCR_IDS.descA1, "columna");
  await seedPage({ descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "texto migrado" });
  await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 2, text: "pagina dos", runId: "run-1" });
  await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "pagina uno", runId: "run-1" });
  // A page row filed under the second tenant on a description the
  // exporting tenant holds.
  await seedPage({ descriptionId: OCR_IDS.descA3, tenantId: OCR_IDS.tenantB, pageSeq: 1, text: "fila ajena" });
});

async function scopeFor(tenant: Tenant) {
  return resolveExportScope(db(), tenant, owner, { kind: "branch", descriptionId: ROOT }, { includeAuthorities: false });
}

describe("canonical CSV, ISAD(G)", () => {
  async function exportCsv() {
    const tenant = await loadTenant(OCR_IDS.tenantA);
    const scope = await scopeFor(tenant);
    const artifact = await emitCanonicalCsv(
      { db: db(), tenant, scope, standard: "isadg", includeAuthorities: false },
      ctx,
    );
    const parsed = decodeAndParseCsv(new TextEncoder().encode(artifact.body));
    const ref = parsed.headers.indexOf("referenceCode");
    const ocr = parsed.headers.indexOf("ocrText");
    const byRef = new Map(parsed.rows.map((r) => [r[ref], r[ocr]]));
    return { parsed, byRef, body: artifact.body };
  }

  it("fills ocrText from the migrated page-1 row, not the column", async () => {
    const { byRef } = await exportCsv();
    expect(byRef.get("pe-bn-cdip-00001")).toBe("texto migrado");
  });

  it("fills ocrText with a run's pages joined in page order", async () => {
    const { byRef } = await exportCsv();
    expect(byRef.get("pe-bn-cdip-00002")).toBe("pagina uno\n\npagina dos");
  });

  it("never carries a page row filed under another tenant", async () => {
    const { byRef, body } = await exportCsv();
    expect(byRef.get("pe-bn-cdip-00003")).toBe("");
    expect(body).not.toContain("fila ajena");
  });

  it("keeps the ISAD(G) header row, ocrText included", async () => {
    const { parsed } = await exportCsv();
    expect(parsed.headers).toEqual(generateCanonicalHeaders("isadg"));
    expect(parsed.headers).toContain("ocrText");
  });
});

describe("JSON, ISAD(G) form", () => {
  async function exportJson() {
    const tenant = await loadTenant(OCR_IDS.tenantA);
    const scope = await scopeFor(tenant);
    const artifact = await emitJson(
      { db: db(), tenant, scope, form: "isadg", ownStandard: "isadg", includeAuthorities: false },
      ctx,
    );
    const doc = JSON.parse(artifact.body) as { records: Array<Record<string, unknown>> };
    const byRef = new Map(doc.records.map((r) => [r.referenceCode as string, r.ocrText]));
    return { doc, byRef, body: artifact.body };
  }

  it("fills ocrText from the migrated page-1 row, not the column", async () => {
    const { byRef } = await exportJson();
    expect(byRef.get("pe-bn-cdip-00001")).toBe("texto migrado");
  });

  it("emits a run's pages joined in page order", async () => {
    const { byRef } = await exportJson();
    expect(byRef.get("pe-bn-cdip-00002")).toBe("pagina uno\n\npagina dos");
  });

  it("never carries a page row filed under another tenant", async () => {
    const { byRef, body } = await exportJson();
    expect(byRef.get("pe-bn-cdip-00003")).toBeNull();
    expect(body).not.toContain("fila ajena");
  });

  it("keys each record in the ISAD(G) column order, ocrText included", async () => {
    const { doc } = await exportJson();
    expect(Object.keys(doc.records[0])).toEqual(generateCanonicalHeaders("isadg"));
    expect(Object.keys(doc.records[0])).toContain("ocrText");
  });
});
