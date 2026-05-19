/**
 * Shared Test Fixtures for EAD3 + Dublin Core Tests
 *
 * This fixture module is the single source of seed data the EAD
 * builder, EAD schema validation, DACS shape lints, DC builder, and
 * DC tests all import from. Centralising the
 * fixture surface means a single fixture change ripples through
 * every downstream test rather than fanning out to four files. The
 * fixture deliberately includes rows with null fields, XML-special
 * characters, and varied description levels so each test exercises
 * the full surface.
 *
 * Tenant UUIDs match the locked test-tenant constants
 * (NEOGRANADINA = isadg; `66666666-6666-4666-8666-666666666666` = DACS;
 * `77777777-7777-4777-8777-777777777777` = RAD). See app/lib/tenant.ts and
 * tests/helpers/db.ts for the canonical declarations these mirror.
 *
 * @version v0.4.0
 */

import type { Standard } from "../../../app/lib/standards/types";

export type EadInput = {
  id: string;
  referenceCode: string;
  title: string;
  descriptionLevel:
    | "fonds"
    | "subfonds"
    | "series"
    | "subseries"
    | "section"
    | "file"
    | "item"
    | "volume";
  dateExpression: string | null;
  extent: string | null;
  creatorDisplay: string | null;
  scopeContent: string | null;
  accessConditions: string | null;
  language: string | null;
  placeDisplay: string | null;
  imprint: string | null;
  parentReferenceCode: string | null;
  repositoryId: string;
  isPublished: boolean;
  legacyIds: Array<{ provider: string; id: string | number }> | null;
};

export type EadRepository = {
  name: string;
  city: string;
  code: string;
  rightsText: string | null;
};

export type ExportTenantFixture = {
  id: string;
  slug: string;
  descriptiveStandard: Standard;
};

// Tenant fixtures — UUIDs match the locked test-tenant constants
// (DACS_TEST_TENANT_ID, RAD_TEST_TENANT_ID) and NEOGRANADINA_TENANT_ID.
// Re-declared here as plain literals (not imported from
// app/lib/tenant.ts or tests/helpers/db.ts) so this fixture file
// stays usable from both the Workers pool and the Node pool without
// dragging app-side imports across the pool boundary.
export const isadgTenant: ExportTenantFixture = {
  id: "c50bfa92-1223-4f00-ba15-d50c39ae3c0b",
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};

export const dacsTenant: ExportTenantFixture = {
  id: "66666666-6666-4666-8666-666666666666",
  slug: "dacs-test",
  descriptiveStandard: "dacs",
};

export const radTenant: ExportTenantFixture = {
  id: "77777777-7777-4777-8777-777777777777",
  slug: "rad-test",
  descriptiveStandard: "rad",
};

export function sampleTenant(standard: Standard): ExportTenantFixture {
  switch (standard) {
    case "isadg":
      return isadgTenant;
    case "dacs":
      return dacsTenant;
    case "rad":
      return radTenant;
  }
}

const REPO_ID = "11111111-aaaa-4bbb-8ccc-dddddddddddd";

export const sampleRepositoryById: ReadonlyMap<string, EadRepository> = new Map([
  [
    REPO_ID,
    {
      name: "Archivo Histórico de Rionegro",
      city: "Rionegro",
      code: "co-ahr",
      rightsText: "All materials in the public domain",
    },
  ],
]);

/**
 * Sample fonds-level + child rows for a single fonds (`co-ahr-gob`).
 *
 * Includes XML-special characters in `title`/`scopeContent` (T-37-02
 * exercise on every test run), null `dateExpression` on the file-level
 * row (RESEARCH Pitfall 4 null-safety coverage), and four description
 * levels so per-level emission can be exercised end-to-end.
 */
export const sampleFondsRows: ReadonlyArray<EadInput> = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    referenceCode: "co-ahr-gob",
    title: "Gobernación de Rionegro <colonial period>", // XML-special chars on purpose
    descriptionLevel: "fonds",
    dateExpression: "1810-1850",
    extent: "50 cajas",
    creatorDisplay: "Gobernación de Rionegro",
    scopeContent: "Documentos administrativos & judiciales", // ampersand on purpose
    accessConditions: "Open access",
    language: "spa",
    placeDisplay: "Rionegro, Antioquia",
    imprint: null,
    parentReferenceCode: null,
    repositoryId: REPO_ID,
    isPublished: true,
    legacyIds: [
      { provider: "ca", id: 12345 },
      { provider: "django", id: "gob_001" },
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    referenceCode: "co-ahr-gob-s1",
    title: "Series I — Correspondencia",
    descriptionLevel: "series",
    dateExpression: "1810-1830",
    extent: "10 cajas",
    creatorDisplay: null,
    scopeContent: null,
    accessConditions: null,
    language: null,
    placeDisplay: null,
    imprint: null,
    parentReferenceCode: "co-ahr-gob",
    repositoryId: REPO_ID,
    isPublished: true,
    legacyIds: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    referenceCode: "co-ahr-gob-s1-f1",
    title: "Carpeta 1 — Borradores",
    descriptionLevel: "file",
    dateExpression: null, // null on purpose — RESEARCH Pitfall 4
    extent: "1 carpeta",
    creatorDisplay: null,
    scopeContent: "Borradores administrativos",
    accessConditions: null,
    language: "spa",
    placeDisplay: null,
    imprint: null,
    parentReferenceCode: "co-ahr-gob-s1",
    repositoryId: REPO_ID,
    isPublished: true,
    legacyIds: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    referenceCode: "co-ahr-gob-s1-f1-i1",
    title: "Item — Carta del 12 de marzo de 1820",
    descriptionLevel: "item",
    dateExpression: "1820-03-12",
    extent: "1 folio",
    creatorDisplay: "Juan García",
    scopeContent: "Carta dirigida al gobernador",
    accessConditions: "Open access",
    language: "spa",
    placeDisplay: "Rionegro",
    imprint: null,
    parentReferenceCode: "co-ahr-gob-s1-f1",
    repositoryId: REPO_ID,
    isPublished: true,
    legacyIds: [{ provider: "ca", id: 99999 }],
  },
];
