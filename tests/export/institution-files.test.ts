/**
 * Tests — the institution files of the export
 *
 * This suite pins the export's three institution files on a real
 * in-Worker D1: `repositories.json`, which the repositories step writes,
 * and `publisher.json` and `vocabulary.json`, which the institution step
 * writes on every publish, all under the publish slug, which are the
 * paths the downstream site's data contract names inside its exports
 * directory.
 * Each file must be exactly what the builders in
 * `app/lib/export/institution-records.server.ts` give for the same rows,
 * so the fixtures the site validated stay valid; the suite reads the rows
 * on its own, builds the files with the builders and compares the bytes.
 *
 * The fixture is the two-tenant federation of
 * `tests/helpers/federation-fixture.ts`, given a publisher record, two
 * credits, a hosting statement, funders on one repository, and approved,
 * deprecated and proposed vocabulary values and authority sources. A
 * second federation's values are seeded too, and must not reach the
 * file, and so are a credit and a funder whose names are blank, which are
 * left out. Further cases cover a repository whose text fields are blank
 * (they export as null), a federation with no hosting statement (its
 * repositories' lines are composed without one), and a deprecated value
 * or source (it carries `deprecated: true`; a proposed one is left out).
 *
 * A further case seeds the Neogranadina relation vocabulary and checks
 * `relation_roles`, `link_attributes`, `genders` and the new groups in
 * `role_groups`, with labels exactly as stored.
 *
 * The last case drives the publish workflow over a run whose types leave
 * out repositories, and checks that both federation files are still
 * written, by a step the plan does not count, so the run's
 * `steps_completed` still reaches its `total_steps`.
 *
 * @version v0.9.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { asc, eq, inArray } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_FEDERATION_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import { exportInstitutionFiles, exportRepositories } from "../../app/lib/export/pipeline.server";
import { PublishExportWorkflow } from "../../app/workflows/publish-export";
import { countPublishSteps } from "../../app/lib/export/publish-steps";
import { resolveExportScope } from "../../app/lib/export/federation-scope.server";
import {
  buildPublisherJson,
  buildRepositoryRecord,
  buildVocabularyJson,
  type ExportRepositoryRecord,
} from "../../app/lib/export/institution-records.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";
import { DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { seedFederationFixture, type Db } from "../helpers/federation-fixture";
import { NEOGRANADINA_RELATIONS } from "../../scripts/data/vocabularies/neogranadina-relations";

/** Records every key and body the step writes. */
class RecordingStorage {
  puts: Array<{ key: string; body: string }> = [];
  async putObject(key: string, body: string): Promise<void> {
    this.puts.push({ key, body });
  }
  async putObjectBytes(key: string, body: Uint8Array): Promise<void> {
    this.puts.push({ key, body: new TextDecoder().decode(body) });
  }
  body(key: string): string {
    const put = this.puts.filter((p) => p.key === key).at(-1);
    if (!put) throw new Error(`nothing written at ${key}`);
    return put.body;
  }
}

const SLUG = "neogranadina";
const LEAD_TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: SLUG,
  descriptiveStandard: "isadg",
};

const NOW = 1_762_000_000_000;

async function seedInstitution(db: Db, options: { hosting: boolean }) {
  await db
    .update(schema.federations)
    .set({
      publisherName: "Fundación de Prueba",
      publisherTaxId: "NIT 000.000.000",
      publisherLocation: "Bogotá, Colombia",
      publisherUrl: "https://example.org",
      publisherEmail: "contacto@example.org",
      publisherLogoKey: "institutions/logo.png",
      manifestBaseUrl: "https://manifests.example.org/",
      descriptionEs: "Una fundación.",
      descriptionEn: "   ",
      termsOfUseEs: "Términos.",
      citationTemplateSiteEs: "{site}, {year}.",
      hostingStatementEs: options.hosting ? "Alojado en el sitio." : null,
      hostingStatementEn: options.hosting ? "Hosted on the site." : null,
    })
    .where(eq(schema.federations.id, DEFAULT_TEST_FEDERATION_ID));

  await db.insert(schema.federationCredits).values([
    { id: "credit-2", federationId: DEFAULT_TEST_FEDERATION_ID, name: "Universidad", role: "funder", url: null, logoKey: null, position: 2 },
    { id: "credit-1", federationId: DEFAULT_TEST_FEDERATION_ID, name: "Socio", role: "partner", url: "https://partner.example.org", logoKey: "institutions/partner.png", position: 1 },
    { id: "credit-3", federationId: DEFAULT_TEST_FEDERATION_ID, name: "  ", role: "host", url: "https://blank.example.org", logoKey: null, position: 3 },
  ]);

  const value = (
    federationId: string,
    list: (typeof schema.vocabularyValues.$inferInsert)["list"],
    code: string,
    extra: Partial<typeof schema.vocabularyValues.$inferInsert> = {},
  ) => ({
    id: `${federationId}-${list}-${code}`,
    federationId,
    list,
    code,
    labelEs: `${code} es`,
    labelEn: `${code} en`,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  });
  await db.insert(schema.vocabularyValues).values([
    value(DEFAULT_TEST_FEDERATION_ID, "entity_type", "person", { position: 1 }),
    value(DEFAULT_TEST_FEDERATION_ID, "entity_type", "corporate_body", { position: 2, status: "deprecated" }),
    value(DEFAULT_TEST_FEDERATION_ID, "entity_type", "family", { position: 3, status: "proposed" }),
    value(DEFAULT_TEST_FEDERATION_ID, "place_type", "river", {
      externalScheme: "aat",
      externalUri: "http://vocab.getty.edu/aat/300008707",
      externalLabel: "rivers",
    }),
    value(DEFAULT_TEST_FEDERATION_ID, "role_group", "parties", { position: 1 }),
    value(DEFAULT_TEST_FEDERATION_ID, "entity_role", "plaintiff", { groupCode: "parties" }),
    value(DEFAULT_TEST_FEDERATION_ID, "entity_role", "witness", { status: "deprecated", labelEn: " " }),
    value(DEFAULT_TEST_FEDERATION_ID, "place_role", "origin"),
    // Another federation's list never reaches this federation's file.
    value(SECOND_TEST_FEDERATION_ID, "entity_type", "elsewhere"),
  ]);

  await db.insert(schema.authoritySources).values([
    { id: "src-viaf", federationId: DEFAULT_TEST_FEDERATION_ID, key: "viaf", labelEs: "VIAF", labelEn: "VIAF", urlTemplate: "https://viaf.org/viaf/{id}", appliesTo: '["entity"]', position: 1 },
    { id: "src-old", federationId: DEFAULT_TEST_FEDERATION_ID, key: "old", labelEs: "Antigua", labelEn: "Old", urlTemplate: "https://old.example.org/{id}", appliesTo: '["place"]', position: 2, status: "deprecated" },
    { id: "src-new", federationId: DEFAULT_TEST_FEDERATION_ID, key: "new", labelEs: "Nueva", labelEn: "New", urlTemplate: "https://new.example.org/{id}", appliesTo: '["entity"]', position: 3, status: "proposed" },
    { id: "src-second", federationId: SECOND_TEST_FEDERATION_ID, key: "second", labelEs: "Otra", labelEn: "Other", urlTemplate: "https://second.example.org/{id}", appliesTo: '["entity"]', position: 1 },
  ]);

  // co-ahr: a full record with funders; co-ahrb: blank text everywhere.
  await db
    .update(schema.repositories)
    .set({
      shortName: "AHR",
      city: "Rionegro",
      region: "Antioquia",
      countryCode: "COL",
      subtitle: "Un archivo municipal.",
      otherNames: '["Archivo de Rionegro"]',
      logoKey: "institutions/ahr.png",
      holdingsEs: "Fondos coloniales.",
      manifestRights: "http://creativecommons.org/licenses/by-nc/4.0/",
      catalogueLicenceUri: "https://creativecommons.org/licenses/by/4.0/",
      creditStatementEs: "Digitalizado en alianza con la fundación.",
      creditStatementEn: "Digitized in partnership with the foundation.",
      rightsText: "Texto de derechos.",
      descriptionLanguage: "spa",
      homeOrder: 1,
      createdAt: 1_700_000_000, // seconds, as some older rows hold
      updatedAt: NOW,
    })
    .where(eq(schema.repositories.code, "co-ahr"));
  await db
    .update(schema.repositories)
    .set({
      shortName: "  ",
      countryCode: "",
      country: " ",
      city: "",
      address: "   ",
      website: "",
      displayTitle: " ",
      subtitle: "",
      region: " ",
      email: "",
      holdingsEs: "  ",
      historyEn: "",
      creditStatementEs: " ",
      rightsText: null,
    })
    .where(eq(schema.repositories.code, "co-ahrb"));

  const ahr = await db
    .select({ id: schema.repositories.id })
    .from(schema.repositories)
    .where(eq(schema.repositories.code, "co-ahr"))
    .get();
  await db.insert(schema.repositoryFunders).values([
    { id: "funder-2", repositoryId: ahr!.id, name: "Programa B", programme: null, projectId: null, url: null, position: 2 },
    { id: "funder-1", repositoryId: ahr!.id, name: "Programa A", programme: "Endangered Archives", projectId: "EAP 0000", url: "https://example.org/eap", position: 1 },
    { id: "funder-3", repositoryId: ahr!.id, name: " ", programme: "Sin nombre", projectId: null, url: null, position: 3 },
  ]);
}

/**
 * The Neogranadina relation set stored the way the vocabulary seed
 * stores it, after an existing `legal` group: the new groups after it,
 * each relation's position its place within its group, the attributes
 * and genders numbered from 1.
 */
async function seedRelationVocabulary(db: Db) {
  const set = NEOGRANADINA_RELATIONS;
  const rows: Array<typeof schema.vocabularyValues.$inferInsert> = [];
  const row = (
    list: (typeof schema.vocabularyValues.$inferInsert)["list"],
    code: string,
    extra: Partial<typeof schema.vocabularyValues.$inferInsert>,
  ) => rows.push({ id: `rel-${list}-${code}`, federationId: DEFAULT_TEST_FEDERATION_ID, list, code, createdAt: NOW, updatedAt: NOW, ...extra });
  row("role_group", "legal", { labelEs: "Jurídico", labelEn: "Legal", position: 1 });
  set.groups.forEach((g, i) => row("role_group", g.code, { labelEs: g.es, labelEn: g.en, position: i + 2 }));
  const within = new Map<string, number>();
  for (const r of set.relations) {
    const position = (within.get(r.group) ?? 0) + 1;
    within.set(r.group, position);
    row("relation_role", r.code, {
      labelEs: r.es.unrecorded,
      labelEn: r.en.unrecorded,
      groupCode: r.group,
      position,
      inverseCode: r.inverse,
      connectorEs: r.es.connector,
      connectorEn: r.en.connector,
      labelEsFemale: r.es.female,
      labelEsMale: r.es.male,
      labelEsUnrecorded: r.es.unrecorded,
      labelEsAlone: r.es.alone ?? null,
      labelEnFemale: r.en.female,
      labelEnMale: r.en.male,
      labelEnUnrecorded: r.en.unrecorded,
      labelEnAlone: r.en.alone ?? null,
    });
  }
  set.attributes.forEach((a, i) => row("link_attribute", a.code, { labelEs: a.es, labelEn: a.en, position: i + 1, hideWhenGroup: a.hideWhenGroup ?? null }));
  set.genders.forEach((g, i) => row("gender", g.code, { labelEs: g.es, labelEn: g.en, position: i + 1 }));
  for (const r of rows) await db.insert(schema.vocabularyValues).values(r);
}

/** Run the repositories and institution steps the way a federation publish runs them. */
async function runStep(db: Db): Promise<RecordingStorage> {
  const scope = await resolveExportScope(db, LEAD_TENANT);
  const storage = new RecordingStorage();
  await exportRepositories(db, storage as unknown as ExportStorage, scope.publishTenant, scope.memberTenantIds);
  await exportInstitutionFiles(db, storage as unknown as ExportStorage, scope.publishTenant);
  return storage;
}

function records(storage: RecordingStorage): ExportRepositoryRecord[] {
  return JSON.parse(storage.body(`${SLUG}/repositories.json`)) as ExportRepositoryRecord[];
}

describe("the export's institution files", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    await seedFederationFixture(db);
  });

  it("writes repositories.json in the repositories step, and publisher.json and vocabulary.json in the institution step", async () => {
    await seedInstitution(db, { hosting: true });
    const scope = await resolveExportScope(db, LEAD_TENANT);
    const repositoriesOnly = new RecordingStorage();
    await exportRepositories(db, repositoriesOnly as unknown as ExportStorage, scope.publishTenant, scope.memberTenantIds);
    expect(repositoriesOnly.puts.map((p) => p.key)).toEqual([`${SLUG}/repositories.json`]);
    const institutionOnly = new RecordingStorage();
    await exportInstitutionFiles(db, institutionOnly as unknown as ExportStorage, scope.publishTenant);
    expect(institutionOnly.puts.map((p) => p.key)).toEqual([`${SLUG}/publisher.json`, `${SLUG}/vocabulary.json`]);

    const storage = await runStep(db);
    // publisher.json and vocabulary.json are single objects; repositories.json an array.
    expect(Array.isArray(JSON.parse(storage.body(`${SLUG}/publisher.json`)))).toBe(false);
    expect(Array.isArray(JSON.parse(storage.body(`${SLUG}/vocabulary.json`)))).toBe(false);
    expect(Array.isArray(JSON.parse(storage.body(`${SLUG}/repositories.json`)))).toBe(true);
  });

  it("writes exactly what the builders give for the same rows", async () => {
    await seedInstitution(db, { hosting: true });
    const storage = await runStep(db);

    const fed = await db
      .select()
      .from(schema.federations)
      .where(eq(schema.federations.id, DEFAULT_TEST_FEDERATION_ID))
      .get();
    const credits = await db
      .select()
      .from(schema.federationCredits)
      .where(eq(schema.federationCredits.federationId, DEFAULT_TEST_FEDERATION_ID))
      .orderBy(asc(schema.federationCredits.position), asc(schema.federationCredits.id))
      .all();
    const values = await db
      .select()
      .from(schema.vocabularyValues)
      .where(eq(schema.vocabularyValues.federationId, DEFAULT_TEST_FEDERATION_ID))
      .all();
    const sources = await db
      .select()
      .from(schema.authoritySources)
      .where(eq(schema.authoritySources.federationId, DEFAULT_TEST_FEDERATION_ID))
      .all();

    expect(storage.body(`${SLUG}/publisher.json`)).toBe(
      JSON.stringify(buildPublisherJson(fed!, credits, fed!.manifestBaseUrl)),
    );
    expect(storage.body(`${SLUG}/vocabulary.json`)).toBe(JSON.stringify(buildVocabularyJson(values, sources)));

    // The record's count and root descriptions are the step's own work,
    // pinned by the pipeline suites; the rest is the builder's.
    const exported = records(storage);
    const repos = await db
      .select()
      .from(schema.repositories)
      .where(inArray(schema.repositories.code, exported.map((r) => r.code)))
      .all();
    const funders = await db
      .select()
      .from(schema.repositoryFunders)
      .orderBy(asc(schema.repositoryFunders.position), asc(schema.repositoryFunders.id))
      .all();
    const expected = exported.map((out) => {
      const repo = repos.find((r) => r.code === out.code)!;
      return buildRepositoryRecord(
        repo,
        funders.filter((f) => f.repositoryId === repo.id),
        { descriptionCount: out.description_count, rootDescriptions: out.root_descriptions },
        fed!.manifestBaseUrl,
        { hostingStatementEs: fed!.hostingStatementEs, hostingStatementEn: fed!.hostingStatementEn },
      );
    });
    expect(storage.body(`${SLUG}/repositories.json`)).toBe(JSON.stringify(expected));

    // Spot checks against the seeded values, so the comparison is not
    // only of the step with itself.
    const ahr = exported.find((r) => r.code === "co-ahr")!;
    expect(ahr.funders.map((f) => f.name)).toEqual(["Programa A", "Programa B"]);
    expect(ahr.logo_url).toBe("https://manifests.example.org/institutions/ahr.png");
    expect(ahr.image_reproduction_text).toBe("Texto de derechos.");
    expect(ahr.created_at).toBe("2023-11-14T22:13:20.000Z");
    expect(ahr.root_descriptions.map((d) => d.reference_code)).toEqual(["co-ahr-gob"]);
    expect(ahr.description_count).toBe(2);
    const publisher = JSON.parse(storage.body(`${SLUG}/publisher.json`));
    expect(publisher.federation).toBe("neogranadina");
    expect(publisher.credits.map((c: { name: string }) => c.name)).toEqual(["Socio", "Universidad"]);
  });

  it("leaves out a credit and a funder whose names are blank", async () => {
    await seedInstitution(db, { hosting: true });
    const storage = await runStep(db);
    const publisher = JSON.parse(storage.body(`${SLUG}/publisher.json`));
    expect(publisher.credits.some((c: { url: string | null }) => c.url === "https://blank.example.org")).toBe(false);
    expect(publisher.credits.every((c: { name: unknown }) => typeof c.name === "string")).toBe(true);
    const ahr = records(storage).find((r) => r.code === "co-ahr")!;
    expect(ahr.funders.map((f) => f.programme)).not.toContain("Sin nombre");
    expect(ahr.funders).toHaveLength(2);
  });

  it("exports a repository's blank text fields as null", async () => {
    await seedInstitution(db, { hosting: true });
    const storage = await runStep(db);
    const ahrb = records(storage).find((r) => r.code === "co-ahrb")!;
    expect(ahrb.short_name).toBeNull();
    expect(ahrb.display_title).toBeNull();
    expect(ahrb.subtitle).toEqual({ es: null, en: null });
    expect(ahrb.city).toBeNull();
    expect(ahrb.country).toBeNull();
    expect(ahrb.country_code).toBeNull();
    expect(ahrb.address).toBeNull();
    expect(ahrb.website).toBeNull();
    expect(ahrb.contact).toEqual({
      street_address: null,
      city: null,
      region: null,
      country: null,
      country_code: null,
      postal_code: null,
      telephone: null,
      email: null,
      website: null,
    });
    expect(ahrb.holdings).toEqual({ es: null, en: null });
    expect(ahrb.history).toEqual({ es: null, en: null });
    expect(ahrb.funders).toEqual([]);
    // image_reproduction_text keeps today's form: an empty string for none.
    expect(ahrb.image_reproduction_text).toBe("");
  });

  it("composes the attribution with the federation's hosting statement", async () => {
    await seedInstitution(db, { hosting: true });
    const storage = await runStep(db);
    const ahr = records(storage).find((r) => r.code === "co-ahr")!;
    expect(ahr.attribution).toEqual({
      es: "Archivo Histórico de Rionegro, Rionegro, Antioquia, Colombia. Digitalizado en alianza con la fundación. Alojado en el sitio. CC BY-NC 4.0.",
      en: "Archivo Histórico de Rionegro, Rionegro, Antioquia, Colombia. Digitized in partnership with the foundation. Hosted on the site. CC BY-NC 4.0.",
    });
  });

  it("still exports a federation with no hosting statement, its lines composed without one", async () => {
    await seedInstitution(db, { hosting: false });
    const storage = await runStep(db);
    const ahr = records(storage).find((r) => r.code === "co-ahr")!;
    expect(ahr.attribution).toEqual({
      es: "Archivo Histórico de Rionegro, Rionegro, Antioquia, Colombia. Digitalizado en alianza con la fundación. CC BY-NC 4.0.",
      en: "Archivo Histórico de Rionegro, Rionegro, Antioquia, Colombia. Digitized in partnership with the foundation. CC BY-NC 4.0.",
    });
    expect(storage.body(`${SLUG}/publisher.json`)).toContain('"federation":"neogranadina"');
  });

  it("marks deprecated values and sources, leaves out proposed ones and other federations' lists", async () => {
    await seedInstitution(db, { hosting: true });
    const storage = await runStep(db);
    const vocabulary = JSON.parse(storage.body(`${SLUG}/vocabulary.json`));
    expect(vocabulary.entity_types).toEqual([
      { code: "person", label: { es: "person es", en: "person en" } },
      { code: "corporate_body", label: { es: "corporate_body es", en: "corporate_body en" }, deprecated: true },
    ]);
    expect(vocabulary.entity_roles).toEqual([
      { code: "plaintiff", label: { es: "plaintiff es", en: "plaintiff en" }, group: "parties" },
      { code: "witness", label: { es: "witness es", en: null }, group: null, deprecated: true },
    ]);
    expect(vocabulary.authority_sources.map((s: { key: string; deprecated?: true }) => [s.key, s.deprecated ?? false])).toEqual([
      ["viaf", false],
      ["old", true],
    ]);
  });

  it("writes an empty publisher record and vocabulary for a federation with none", async () => {
    const storage = await runStep(db);
    const publisher = JSON.parse(storage.body(`${SLUG}/publisher.json`));
    expect(publisher.federation).toBe("neogranadina");
    expect(publisher.legal_name).toBeNull();
    expect(publisher.credits).toEqual([]);
    expect(JSON.parse(storage.body(`${SLUG}/vocabulary.json`))).toEqual({
      entity_types: [],
      place_types: [],
      role_groups: [],
      entity_roles: [],
      place_roles: [],
      authority_sources: [],
      relation_roles: [],
      link_attributes: [],
      genders: [],
    });
  });

  it("carries the federation's relation vocabulary as stored: roles, attributes, genders and the new groups", async () => {
    await seedRelationVocabulary(db);
    const storage = await runStep(db);
    const body = storage.body(`${SLUG}/vocabulary.json`);
    const vocabulary = JSON.parse(body);

    // The four new groups follow the existing one, in role_groups' own shape.
    expect(vocabulary.role_groups).toEqual([
      { code: "legal", label: { es: "Jurídico", en: "Legal" }, order: 1 },
      ...NEOGRANADINA_RELATIONS.groups.map((g, i) => ({ code: g.code, label: { es: g.es, en: g.en }, order: i + 2 })),
    ]);

    // Ordered by group position, then the value's position in its group.
    const groupOrder = ["legal", ...NEOGRANADINA_RELATIONS.groups.map((g) => g.code)];
    const expectedOrder = [...NEOGRANADINA_RELATIONS.relations]
      .map((r, i) => ({ r, i }))
      .sort((a, b) => groupOrder.indexOf(a.r.group) - groupOrder.indexOf(b.r.group) || a.i - b.i)
      .map(({ r }) => r.code);
    expect(vocabulary.relation_roles.map((r: { code: string }) => r.code)).toEqual(expectedOrder);

    const byCode = new Map(vocabulary.relation_roles.map((r: { code: string }) => [r.code, r]));
    // A gendered code: all four forms in each language, and its connector.
    expect(byCode.get("enslaved")).toEqual({
      code: "enslaved",
      label: {
        es: { female: "esclavizada", male: "esclavizado", unrecorded: "persona esclavizada" },
        en: { female: "enslaved", male: "enslaved", unrecorded: "enslaved", alone: "enslaved person" },
      },
      connector: { es: "por", en: "by" },
      inverse: "enslaver",
      group: "enslavement",
    });
    // `alone` only where it is stored.
    expect(byCode.get("parent")).toEqual({
      code: "parent",
      label: {
        es: { female: "madre", male: "padre", unrecorded: "madre o padre" },
        en: { female: "mother", male: "father", unrecorded: "parent" },
      },
      connector: { es: "de", en: "of" },
      inverse: "child",
      group: "kinship",
    });
    for (const r of NEOGRANADINA_RELATIONS.relations) {
      const exported = byCode.get(r.code) as { label: Record<"es" | "en", Record<string, string>> };
      for (const lang of ["es", "en"] as const) {
        expect(exported.label[lang].alone).toBe(r[lang].alone);
      }
    }

    expect(vocabulary.link_attributes).toEqual(
      NEOGRANADINA_RELATIONS.attributes.map((a, i) => ({
        key: a.code,
        label: { es: a.es, en: a.en },
        order: i + 1,
        hide_when_group: a.hideWhenGroup ?? null,
      })),
    );
    expect(vocabulary.genders).toEqual([
      { code: "female", label: { es: "Mujer", en: "Woman" } },
      { code: "male", label: { es: "Hombre", en: "Man" } },
    ]);

    // Byte for byte as stored, case included.
    expect(body).toContain(JSON.stringify("Vínculos entre personas esclavizadas"));
    expect(body).toContain(JSON.stringify("who appointed"));
    expect(body).toContain(JSON.stringify("menor bajo tutela o curaduría"));
  });

  it("writes publisher.json and vocabulary.json on a publish that leaves out repositories, in a step the plan does not count", async () => {
    await seedInstitution(db, { hosting: true });
    const now = Date.now();
    const userId = "u-inst-0000-0000-0000-000000000001";
    await db.insert(schema.users).values({
      id: userId, tenantId: DEFAULT_TEST_TENANT_ID, email: "inst@example.com", isSuperAdmin: true, createdAt: now, updatedAt: now,
    });
    const config = {
      selectedFonds: ["co-ahrb-gob"],
      selectedTypes: ["descriptions"],
      authoritiesEnabled: false,
    };
    const totalSteps = countPublishSteps(config);
    const exportId = "44444444-4444-4444-8444-dddddddddddd";
    await db.insert(schema.exportRuns).values({
      id: exportId, triggeredBy: userId, tenantId: DEFAULT_TEST_TENANT_ID, status: "pending",
      selectedFonds: JSON.stringify(config.selectedFonds), selectedTypes: JSON.stringify(config.selectedTypes),
      stepsCompleted: 0, totalSteps, createdAt: now,
    });
    for (const key of [`${SLUG}/publisher.json`, `${SLUG}/vocabulary.json`]) await env.EXPORT_BUCKET.delete(key);
    // A publish of one fonds keeps the other published fonds' entries from
    // the stored descriptions index, and fails the run without one.
    await env.EXPORT_BUCKET.put(
      `${SLUG}/descriptions-index.json`,
      JSON.stringify({ version: 1, generated_at: new Date(now).toISOString(), total_record_count: 0, fonds: [] })
    );

    const names: string[] = [];
    const step = {
      async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
        const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
        names.push(name);
        const result = await callback();
        return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
      },
    };
    const workflow = Object.create(PublishExportWorkflow.prototype) as PublishExportWorkflow;
    (workflow as any).env = env;
    await workflow.run({ payload: { exportId }, timestamp: new Date(), instanceId: "i" } as any, step as any);

    expect(names).not.toContain("repositories");
    expect(names).toContain("institution");
    expect(names.indexOf("institution")).toBe(names.indexOf("finalize") - 1);

    const publisher = await env.EXPORT_BUCKET.get(`${SLUG}/publisher.json`);
    const vocabulary = await env.EXPORT_BUCKET.get(`${SLUG}/vocabulary.json`);
    expect(JSON.parse(await publisher!.text()).federation).toBe("neogranadina");
    expect(JSON.parse(await vocabulary!.text()).entity_types.map((v: { code: string }) => v.code)).toEqual([
      "person",
      "corporate_body",
    ]);

    const run = await env.DB.prepare(
      "SELECT status, current_step, steps_completed, total_steps FROM export_runs WHERE id = ?"
    ).bind(exportId).first<{ status: string; current_step: string | null; steps_completed: number; total_steps: number }>();
    expect(run!.status).toBe("complete");
    expect(run!.steps_completed).toBe(run!.total_steps);
    expect(run!.current_step).not.toBe("institution");
  });
});

// @version v0.9.0
