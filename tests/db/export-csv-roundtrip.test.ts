/**
 * Tests — canonical CSV round trip
 *
 * The flagship pin for `app/lib/export/canonical-csv.server.ts`: a scope
 * emitted as canonical CSV, then read back through the IMPORT module's
 * own reader (`decodeAndParseCsv` / `parseCsv`, `app/lib/import/csv.ts`)
 * rather than any hand-rolled parsing, so this test exercises the actual
 * seam export → edit in a spreadsheet → re-import depends on.
 *
 * Two cases:
 *
 *   - Authorities OFF: the pure single-block layout. Headers must equal
 *     `generateCanonicalHeaders(standard)` verbatim (the same column
 *     contract the import template downloads), and cell values must
 *     round-trip byte-exact — a title carrying a quote, a comma and an
 *     embedded newline survives the quote/unquote cycle unchanged,
 *     `hasDigital` comes back empty on every row (the deliberate
 *     asymmetry the module's header explains), and a child's `parent`
 *     cell resolves to the parent's reference code rather than its id.
 *
 *   - Authorities ON: the discriminated layout — a leading `rowType`
 *     column, then the description/entity/place/link column blocks.
 *     Filtering to `rowType = description` and dropping the first
 *     column must reproduce the pure layout's own rows exactly, which
 *     is the property that keeps the two layouts one format rather than
 *     two; the other four row kinds (`entity`, `place`, `entityLink`,
 *     `placeLink`) must all appear, since this fixture links one entity
 *     and one place to the same description.
 *
 * FIXTURES. The DACS test tenant, not Neogranadina — DACS is the one
 * seeded standard whose profile declares `hasDigital`
 * (`app/lib/standards/dacs.ts`; ISAD(G) does not), and the emitted
 * `hasDigital` cell is one of the properties this file pins. A
 * three-node branch (a series and two children) gives the parent-
 * resolution and multi-row cases in one scope; one of the two children
 * carries the quote/comma/newline title.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { DACS_TEST_TENANT_ID } from "../../app/lib/tenant";
import { resolveExportScope } from "../../app/lib/export/scopes.server";
import {
  emitCanonicalCsv,
  canonicalCsvHeaders,
  ROW_TYPE_COLUMN,
} from "../../app/lib/export/canonical-csv.server";
import type { ExportEmitContext } from "../../app/lib/export/canonical-csv.server";
import { generateCanonicalHeaders } from "../../app/lib/import/canonical-template";
import { decodeAndParseCsv } from "../../app/lib/import/csv";
import type { Tenant, User } from "../../app/context";

const TENANT = DACS_TEST_TENANT_ID;
const REPO = "8c200000-0000-4000-8000-000000000001";
const OWNER_ID = "8a200000-0000-4000-8000-000000000001";

/** The title deliberately carrying a quote, a comma and a newline. */
const SPECIAL_TITLE = 'Carta de "urgencia", enviada el mismo día\nSegunda línea del asunto';

function db() {
  return drizzle(env.DB, { schema });
}

function makeUser(overrides: Partial<User> & Pick<User, "id" | "tenantId">): User {
  return {
    email: `${overrides.id}@test.local`,
    name: null,
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    lastActiveAt: null,
    githubId: null,
    ...overrides,
  };
}

const owner = makeUser({ id: OWNER_ID, tenantId: TENANT });

/** A no-op emit context: this test cares about bytes, not progress. */
const ctx: ExportEmitContext = {
  checkpoint: async () => {},
};

async function loadTenant(id: string): Promise<Tenant> {
  const row = await db().select().from(schema.tenants).where(eq(schema.tenants.id, id)).get();
  if (!row) throw new Error(`tenant ${id} not seeded`);
  return row as Tenant;
}

async function seedUser(id: string, tenantId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, tenantId, `${id}@test.local`, 0, now, now)
    .run();
}

async function seedRepository(id: string, tenantId: string, code: string): Promise<void> {
  const now = Date.now();
  await db().insert(schema.repositories).values({
    id,
    tenantId,
    code,
    name: `Repository ${code}`,
    countryCode: "COL",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedDescription(values: {
  id: string;
  referenceCode: string;
  title: string;
  parentId?: string | null;
  position?: number;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.descriptions).values({
    id: values.id,
    tenantId: TENANT,
    repositoryId: REPO,
    parentId: values.parentId ?? null,
    position: values.position ?? 0,
    descriptionLevel: values.parentId ? "item" : "series",
    referenceCode: values.referenceCode,
    title: values.title,
    legacyIds: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedEntity(values: {
  id: string;
  federationId: string;
  displayName: string;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.entities).values({
    id: values.id,
    federationId: values.federationId,
    tenantId: TENANT,
    entityCode: `dacs-${values.id.slice(-6)}`,
    displayName: values.displayName,
    sortName: values.displayName.toLowerCase(),
    entityType: "person",
    nameVariants: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPlace(values: {
  id: string;
  federationId: string;
  displayName: string;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.places).values({
    id: values.id,
    federationId: values.federationId,
    tenantId: TENANT,
    placeCode: `dacs-p-${values.id.slice(-6)}`,
    label: values.displayName,
    displayName: values.displayName,
    nameVariants: "[]",
    legacyIds: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedEntityLink(descriptionId: string, entityId: string): Promise<void> {
  await db().insert(schema.descriptionEntities).values({
    id: crypto.randomUUID(),
    descriptionId,
    entityId,
    role: "author",
    sequence: 0,
    createdAt: Date.now(),
  });
}

async function seedPlaceLink(descriptionId: string, placeId: string): Promise<void> {
  await db().insert(schema.descriptionPlaces).values({
    id: crypto.randomUUID(),
    descriptionId,
    placeId,
    role: "created",
    createdAt: Date.now(),
  });
}

describe("canonical CSV round trip", () => {
  let tenant: Tenant;
  let parentId: string;
  let specialId: string;
  let plainId: string;

  beforeAll(async () => {
    await applyMigrations();
    await cleanDatabase();
    await seedUser(OWNER_ID, TENANT);
    await seedRepository(REPO, TENANT, "CSV-RT");
    tenant = await loadTenant(TENANT);

    parentId = crypto.randomUUID();
    specialId = crypto.randomUUID();
    plainId = crypto.randomUUID();

    await seedDescription({
      id: parentId,
      referenceCode: "CSV-RT-P01",
      title: "Serie de correspondencia",
    });
    await seedDescription({
      id: specialId,
      referenceCode: "CSV-RT-C01",
      title: SPECIAL_TITLE,
      parentId,
      position: 0,
    });
    await seedDescription({
      id: plainId,
      referenceCode: "CSV-RT-C02",
      title: "Carta ordinaria",
      parentId,
      position: 1,
    });
  });

  describe("authorities off — the pure single-block layout", () => {
    it("emits generateCanonicalHeaders(standard) verbatim, with byte-exact values, a blank hasDigital, and the parent resolved to a reference code", async () => {
      const scope = await resolveExportScope(
        db(),
        tenant,
        owner,
        { kind: "branch", descriptionId: parentId },
        { includeAuthorities: false },
      );
      const artifact = await emitCanonicalCsv(
        { db: db(), tenant, scope, standard: "dacs", includeAuthorities: false },
        ctx,
      );

      const bytes = new TextEncoder().encode(artifact.body);
      const parsed = decodeAndParseCsv(bytes);

      const expectedHeaders = generateCanonicalHeaders("dacs");
      expect(parsed.headers).toEqual(expectedHeaders);
      expect(parsed.headers).not.toContain(ROW_TYPE_COLUMN);
      expect(parsed.rowCount).toBe(3);

      const refIdx = parsed.headers.indexOf("referenceCode");
      const titleIdx = parsed.headers.indexOf("title");
      const parentIdx = parsed.headers.indexOf("parent");
      const hasDigitalIdx = parsed.headers.indexOf("hasDigital");
      expect(hasDigitalIdx).toBeGreaterThanOrEqual(0);

      const byRef = new Map(parsed.rows.map((row) => [row[refIdx], row]));

      const rootRow = byRef.get("CSV-RT-P01");
      expect(rootRow?.[parentIdx]).toBe("");
      expect(rootRow?.[hasDigitalIdx]).toBe("");

      const specialRow = byRef.get("CSV-RT-C01");
      expect(specialRow).toBeDefined();
      // Byte-exact: the quote, the comma and the embedded newline all
      // survive the quote/unquote cycle unchanged.
      expect(specialRow?.[titleIdx]).toBe(SPECIAL_TITLE);
      expect(specialRow?.[parentIdx]).toBe("CSV-RT-P01");
      expect(specialRow?.[hasDigitalIdx]).toBe("");

      const plainRow = byRef.get("CSV-RT-C02");
      expect(plainRow?.[titleIdx]).toBe("Carta ordinaria");
      expect(plainRow?.[parentIdx]).toBe("CSV-RT-P01");
      expect(plainRow?.[hasDigitalIdx]).toBe("");
    });
  });

  describe("authorities on — the discriminated layout", () => {
    it("carries a leading rowType column, all five row kinds, and reproduces the pure layout once filtered to description rows with column one dropped", async () => {
      const entityId = crypto.randomUUID();
      const placeId = crypto.randomUUID();
      await seedEntity({
        id: entityId,
        federationId: tenant.federationId as string,
        displayName: "Autor Enlazado",
      });
      await seedPlace({
        id: placeId,
        federationId: tenant.federationId as string,
        displayName: "Lugar Enlazado",
      });
      await seedEntityLink(plainId, entityId);
      await seedPlaceLink(plainId, placeId);

      // The pure layout, over the SAME description members, for the
      // reproduction check below.
      const pureScope = await resolveExportScope(
        db(),
        tenant,
        owner,
        { kind: "branch", descriptionId: parentId },
        { includeAuthorities: false },
      );
      const pureArtifact = await emitCanonicalCsv(
        { db: db(), tenant, scope: pureScope, standard: "dacs", includeAuthorities: false },
        ctx,
      );
      const pureParsed = decodeAndParseCsv(new TextEncoder().encode(pureArtifact.body));

      const scope = await resolveExportScope(
        db(),
        tenant,
        owner,
        { kind: "branch", descriptionId: parentId },
        { includeAuthorities: true },
      );
      expect(scope.entityIds).toEqual([entityId]);
      expect(scope.placeIds).toEqual([placeId]);

      const artifact = await emitCanonicalCsv(
        { db: db(), tenant, scope, standard: "dacs", includeAuthorities: true },
        ctx,
      );
      const parsed = decodeAndParseCsv(new TextEncoder().encode(artifact.body));

      const descriptionColumns = generateCanonicalHeaders("dacs");
      expect(parsed.headers[0]).toBe(ROW_TYPE_COLUMN);
      expect(parsed.headers.slice(1, 1 + descriptionColumns.length)).toEqual(
        descriptionColumns,
      );
      expect(parsed.headers).toEqual(
        canonicalCsvHeaders("dacs", { descriptions: true, authorities: true }),
      );

      const rowTypeIdx = 0;
      const kinds = new Set(parsed.rows.map((row) => row[rowTypeIdx]));
      expect(kinds).toEqual(
        new Set(["description", "entity", "place", "entityLink", "placeLink"]),
      );

      const descriptionRows = parsed.rows
        .filter((row) => row[rowTypeIdx] === "description")
        .map((row) => row.slice(1, 1 + descriptionColumns.length));
      expect(descriptionRows).toEqual(pureParsed.rows);
    });
  });
});
