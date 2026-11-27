/**
 * Tests for the Institution Records Builders
 *
 * This suite deals with pinning the three institution records the export
 * will publish beside the catalogue: `publisher.json` (the federation as
 * publisher), the full repository record that `repositories.json` carries,
 * and `vocabulary.json` (a federation's controlled lists and authority
 * sources). The cases check the exact key order and nesting the
 * downstream site reads, null handling for every optional column, the
 * absolute URLs built from object keys, the finite set of licence URIs
 * whose labels are derived, the ordering and filtering of vocabulary
 * values, and the composed attribution line with its per-language
 * override and the federation's hosting statement, present or absent in
 * either language, and the country each line names in its own language
 * from the country code. The relation lists (`relation_roles`,
 * `link_attributes`, `genders`) are checked for shape, order, the
 * `alone` rule and labels exactly as stored. The builders are pure, so the
 * fixtures are inline rows rather than a seeded D1.
 *
 * @version v0.9.0
 */

import { describe, it, expect } from "vitest";
import {
  buildPublisherJson,
  buildRepositoryRecord,
  buildVocabularyJson,
  composeAttribution,
  joinAssetUrl,
  repositoryAttribution,
  licenceLabel,
  type PublisherSource,
  type CreditSource,
  type RepositorySource,
  type FunderSource,
  type VocabularyValueSource,
  type AuthoritySourceSource,
} from "./institution-records.server";

const BASE = "https://manifests.example.org";

function federation(over: Partial<PublisherSource> = {}): PublisherSource {
  return {
    slug: "neogranadina",
    name: "Neogranadina",
    publisherName: "Fundación Histórica Neogranadina",
    publisherTaxId: "NIT 900.861.407",
    publisherLocation: "Bogotá, Colombia",
    publisherUrl: "https://neogranadina.org",
    publisherEmail: "contacto@neogranadina.org",
    publisherLogoKey: null,
    descriptionEs: null,
    descriptionEn: null,
    termsOfUseEs: null,
    termsOfUseEn: null,
    privacyEs: null,
    privacyEn: null,
    takedownEs: null,
    takedownEn: null,
    citationTemplateSiteEs: null,
    citationTemplateSiteEn: null,
    citationTemplateRecordEs: null,
    citationTemplateRecordEn: null,
    ...over,
  };
}

function repo(over: Partial<RepositorySource> = {}): RepositorySource {
  return {
    id: "r1",
    code: "co-cihjml",
    name: "Centro de Investigaciones Históricas",
    shortName: "CIHJML",
    countryCode: "COL",
    country: "Colombia",
    city: "Popayán",
    address: null,
    website: null,
    displayTitle: "Antiguo Archivo Central del Cauca",
    subtitle: "Subtítulo",
    subtitleEn: null,
    heroImageUrl: null,
    otherNames: null,
    institutionType: null,
    logoKey: null,
    region: "Cauca",
    postalCode: null,
    telephone: null,
    email: null,
    holdingsEs: null,
    holdingsEn: null,
    historyEs: null,
    historyEn: null,
    openingTimesEs: null,
    openingTimesEn: null,
    accessConditionsEs: null,
    accessConditionsEn: null,
    accessibilityEs: null,
    accessibilityEn: null,
    reproductionServicesEs: null,
    reproductionServicesEn: null,
    manifestRights: null,
    catalogueLicenceUri: null,
    attributionEs: null,
    attributionEn: null,
    creditStatementEs: null,
    creditStatementEn: null,
    rightsText: null,
    descriptionLanguage: "spa",
    homeOrder: 1,
    createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    updatedAt: Date.UTC(2026, 10, 1, 0, 0, 0),
    ...over,
  };
}

const NULLS = { es: null, en: null };
const PLACE = "Centro de Investigaciones Históricas, Popayán, Cauca, Colombia.";

describe("joinAssetUrl", () => {
  it("joins a base and a key with one slash, whatever the base ends with", () => {
    expect(joinAssetUrl(BASE, "institutions/x/logo.png")).toBe(`${BASE}/institutions/x/logo.png`);
    expect(joinAssetUrl(`${BASE}/`, "institutions/x/logo.png")).toBe(`${BASE}/institutions/x/logo.png`);
    expect(joinAssetUrl(`${BASE}//`, "/institutions/x/logo.png")).toBe(`${BASE}/institutions/x/logo.png`);
  });
  it("is null when the key or the base is null", () => {
    expect(joinAssetUrl(BASE, null)).toBeNull();
    expect(joinAssetUrl(null, "institutions/x/logo.png")).toBeNull();
  });
});

describe("licenceLabel", () => {
  it.each([
    ["http://creativecommons.org/licenses/by-nc/4.0/", "CC BY-NC 4.0"],
    ["https://creativecommons.org/licenses/by-nc/4.0", "CC BY-NC 4.0"],
    ["https://creativecommons.org/licenses/by/4.0/", "CC BY 4.0"],
    ["http://creativecommons.org/licenses/by-sa/4.0", "CC BY-SA 4.0"],
    ["https://creativecommons.org/licenses/by-nc-sa/4.0/", "CC BY-NC-SA 4.0"],
    ["https://creativecommons.org/licenses/by-nd/4.0/", "CC BY-ND 4.0"],
    ["https://creativecommons.org/licenses/by-nc-nd/4.0/", "CC BY-NC-ND 4.0"],
    ["http://creativecommons.org/publicdomain/zero/1.0/", "CC0 1.0"],
    ["https://creativecommons.org/publicdomain/mark/1.0", "Public Domain Mark 1.0"],
  ])("labels %s as %s in both languages", (uri, label) => {
    expect(licenceLabel(uri)).toEqual({ es: label, en: label });
  });

  it.each([
    "https://creativecommons.org/licenses/by-nc/3.0/",
    "https://creativecommons.org/licenses/by-nc/4.0/deed.es",
    "https://creativecommons.org/licenses/by-nc/4.0//",
    "HTTPS://CREATIVECOMMONS.ORG/LICENSES/BY-NC/4.0/",
    "https://www.creativecommons.org/licenses/by-nc/4.0/",
    "https://example.org/licence",
    "",
  ])("gives no label to %s, outside the map", (uri) => {
    expect(licenceLabel(uri)).toEqual(NULLS);
  });

  it("gives no label to a null URI", () => {
    expect(licenceLabel(null)).toEqual(NULLS);
  });
});

describe("buildPublisherJson", () => {
  it("writes the contract keys in order", () => {
    const out = buildPublisherJson(federation(), [], BASE);
    expect(Object.keys(out)).toEqual([
      "federation", "legal_name", "display_name", "tax_id", "location", "website", "email",
      "logo_url", "description", "terms_of_use", "privacy", "takedown", "citation_template", "credits",
    ]);
    expect(Object.keys(out.citation_template)).toEqual(["site", "record"]);
  });

  it("maps the columns and nulls to the shape", () => {
    expect(buildPublisherJson(federation(), [], BASE)).toEqual({
      federation: "neogranadina",
      legal_name: "Fundación Histórica Neogranadina",
      display_name: "Neogranadina",
      tax_id: "NIT 900.861.407",
      location: "Bogotá, Colombia",
      website: "https://neogranadina.org",
      email: "contacto@neogranadina.org",
      logo_url: null,
      description: NULLS,
      terms_of_use: NULLS,
      privacy: NULLS,
      takedown: NULLS,
      citation_template: { site: NULLS, record: NULLS },
      credits: [],
    });
  });

  it("pairs each prose column into es and en, keeping a lone language", () => {
    const out = buildPublisherJson(
      federation({
        descriptionEs: "Desc",
        termsOfUseEn: "Terms",
        privacyEs: "Priv",
        privacyEn: "Privacy",
        takedownEn: "Takedown",
        citationTemplateSiteEs: "{site}, {year}",
        citationTemplateRecordEn: "{title}. {url}",
      }),
      [],
      BASE,
    );
    expect(out.description).toEqual({ es: "Desc", en: null });
    expect(out.terms_of_use).toEqual({ es: null, en: "Terms" });
    expect(out.privacy).toEqual({ es: "Priv", en: "Privacy" });
    expect(out.takedown).toEqual({ es: null, en: "Takedown" });
    expect(out.citation_template).toEqual({
      site: { es: "{site}, {year}", en: null },
      record: { es: null, en: "{title}. {url}" },
    });
  });

  it("builds the logo URL from the key, with or without a trailing slash on the base", () => {
    const fed = federation({ publisherLogoKey: "institutions/neogranadina/logo.svg" });
    expect(buildPublisherJson(fed, [], BASE).logo_url).toBe(`${BASE}/institutions/neogranadina/logo.svg`);
    expect(buildPublisherJson(fed, [], `${BASE}/`).logo_url).toBe(`${BASE}/institutions/neogranadina/logo.svg`);
    expect(buildPublisherJson(fed, [], null).logo_url).toBeNull();
  });

  it("exports blank text as null", () => {
    const out = buildPublisherJson(
      federation({
        publisherName: "  ",
        publisherTaxId: "",
        publisherLocation: "\n",
        publisherUrl: " ",
        publisherEmail: "\t ",
        publisherLogoKey: "  ",
        descriptionEs: " ",
        descriptionEn: "Text",
        citationTemplateSiteEs: "",
        citationTemplateRecordEn: "  ",
      }),
      [{ name: "Credit", role: "host", url: " ", logoKey: "", position: 0 }],
      BASE,
    );
    expect(out.legal_name).toBeNull();
    expect(out.tax_id).toBeNull();
    expect(out.location).toBeNull();
    expect(out.website).toBeNull();
    expect(out.email).toBeNull();
    expect(out.logo_url).toBeNull();
    expect(out.description).toEqual({ es: null, en: "Text" });
    expect(out.citation_template).toEqual({ site: NULLS, record: NULLS });
    expect(out.credits).toEqual([{ name: "Credit", role: "host", url: null, logo_url: null }]);
  });

  it("keeps text that is not blank unchanged, surrounding spaces included", () => {
    expect(buildPublisherJson(federation({ publisherTaxId: " NIT 1 " }), [], BASE).tax_id).toBe(" NIT 1 ");
  });

  it("orders credits by position and writes their keys in order", () => {
    const credits: CreditSource[] = [
      { name: "B", role: "funder", url: null, logoKey: "institutions/b.png", position: 2 },
      { name: "A", role: "partner", url: "https://a.example", logoKey: null, position: 1 },
    ];
    const out = buildPublisherJson(federation(), credits, `${BASE}/`);
    expect(out.credits).toEqual([
      { name: "A", role: "partner", url: "https://a.example", logo_url: null },
      { name: "B", role: "funder", url: null, logo_url: `${BASE}/institutions/b.png` },
    ]);
    expect(Object.keys(out.credits[0])).toEqual(["name", "role", "url", "logo_url"]);
  });

  it("leaves out a credit whose name is blank", () => {
    const credits: CreditSource[] = [
      { name: "  ", role: "funder", url: "https://blank.example", logoKey: null, position: 1 },
      { name: "", role: "host", url: null, logoKey: null, position: 2 },
      { name: "A", role: "partner", url: null, logoKey: null, position: 3 },
    ];
    expect(buildPublisherJson(federation(), credits, BASE).credits).toEqual([
      { name: "A", role: "partner", url: null, logo_url: null },
    ]);
  });
});

describe("buildRepositoryRecord", () => {
  const extras = { descriptionCount: 7, rootDescriptions: [] };

  it("writes the contract keys in order, with today's flat fields kept", () => {
    const out = buildRepositoryRecord(repo(), [], extras, BASE, null);
    expect(Object.keys(out)).toEqual([
      "id", "code", "name", "short_name", "display_title", "subtitle", "hero_image_url",
      "other_names", "institution_type", "logo_url", "contact",
      "city", "country", "country_code", "address", "website", "image_reproduction_text",
      "holdings", "history", "access", "reproduction_services",
      "image_licence", "catalogue_licence", "funders", "attribution",
      "description_language", "home_order", "created_at", "updated_at",
      "description_count", "root_descriptions",
    ]);
    expect(Object.keys(out.contact)).toEqual([
      "street_address", "city", "region", "country", "country_code", "postal_code",
      "telephone", "email", "website",
    ]);
    expect(Object.keys(out.access)).toEqual(["opening_times", "conditions", "accessibility"]);
    expect(Object.keys(out.image_licence)).toEqual(["uri", "label"]);
  });

  it("maps a sparse row to nulls and empty lists", () => {
    const out = buildRepositoryRecord(repo(), [], extras, BASE, null);
    expect(out).toEqual({
      id: "r1",
      code: "co-cihjml",
      name: "Centro de Investigaciones Históricas",
      short_name: "CIHJML",
      display_title: "Antiguo Archivo Central del Cauca",
      subtitle: { es: "Subtítulo", en: null },
      hero_image_url: null,
      other_names: [],
      institution_type: null,
      logo_url: null,
      contact: {
        street_address: null, city: "Popayán", region: "Cauca", country: "Colombia",
        country_code: "COL", postal_code: null, telephone: null, email: null, website: null,
      },
      city: "Popayán",
      country: "Colombia",
      country_code: "COL",
      address: null,
      website: null,
      image_reproduction_text: "",
      holdings: NULLS,
      history: NULLS,
      access: { opening_times: NULLS, conditions: NULLS, accessibility: NULLS },
      reproduction_services: NULLS,
      image_licence: { uri: null, label: NULLS },
      catalogue_licence: { uri: null, label: NULLS },
      funders: [],
      attribution: { es: PLACE, en: PLACE },
      description_language: "spa",
      home_order: 1,
      created_at: "2026-01-02T03:04:05.000Z",
      updated_at: "2026-11-01T00:00:00.000Z",
      description_count: 7,
      root_descriptions: [],
    });
  });

  it("fills contact, prose pairs and the logo URL from the columns", () => {
    const out = buildRepositoryRecord(
      repo({
        address: "Calle 1",
        website: "https://archivo.example",
        postalCode: "190001",
        telephone: "+57 1",
        email: "a@example.org",
        subtitleEn: "Subtitle",
        holdingsEs: "Fondos",
        historyEn: "History",
        openingTimesEs: "L-V",
        accessConditionsEn: "Open",
        accessibilityEs: "Rampa",
        reproductionServicesEs: "Copias",
        reproductionServicesEn: "Copies",
        logoKey: "institutions/co-cihjml/logo.png",
        heroImageUrl: `${BASE}/institutions/co-cihjml/hero.jpg`,
        institutionType: "university",
        homeOrder: null,
      }),
      [],
      extras,
      `${BASE}/`,
      null,
    );
    expect(out.contact.street_address).toBe("Calle 1");
    expect(out.contact.website).toBe("https://archivo.example");
    expect(out.address).toBe("Calle 1");
    expect(out.contact.postal_code).toBe("190001");
    expect(out.contact.telephone).toBe("+57 1");
    expect(out.contact.email).toBe("a@example.org");
    expect(out.subtitle).toEqual({ es: "Subtítulo", en: "Subtitle" });
    expect(out.holdings).toEqual({ es: "Fondos", en: null });
    expect(out.history).toEqual({ es: null, en: "History" });
    expect(out.access).toEqual({
      opening_times: { es: "L-V", en: null },
      conditions: { es: null, en: "Open" },
      accessibility: { es: "Rampa", en: null },
    });
    expect(out.reproduction_services).toEqual({ es: "Copias", en: "Copies" });
    expect(out.logo_url).toBe(`${BASE}/institutions/co-cihjml/logo.png`);
    expect(out.hero_image_url).toBe(`${BASE}/institutions/co-cihjml/hero.jpg`);
    expect(out.institution_type).toBe("university");
    expect(out.home_order).toBeNull();
  });

  it("labels the image and catalogue licences from their URIs, and keeps an unknown URI unlabelled", () => {
    const out = buildRepositoryRecord(
      repo({
        manifestRights: "http://creativecommons.org/licenses/by-nc/4.0/",
        catalogueLicenceUri: "https://example.org/custom-licence",
      }),
      [],
      extras,
      BASE,
      null,
    );
    expect(out.image_licence).toEqual({
      uri: "http://creativecommons.org/licenses/by-nc/4.0/",
      label: { es: "CC BY-NC 4.0", en: "CC BY-NC 4.0" },
    });
    expect(out.catalogue_licence).toEqual({ uri: "https://example.org/custom-licence", label: NULLS });
  });

  it("parses other names, and reads a null, invalid or non-list value as none", () => {
    expect(buildRepositoryRecord(repo({ otherNames: '["Archivo Central","ACC"]' }), [], extras, BASE, null).other_names)
      .toEqual(["Archivo Central", "ACC"]);
    for (const bad of [null, "", "not json", '{"a":1}', '"one"', "[1,2]"]) {
      expect(buildRepositoryRecord(repo({ otherNames: bad }), [], extras, BASE, null).other_names).toEqual([]);
    }
  });

  it("orders funders by position and writes their keys in order", () => {
    const funders: FunderSource[] = [
      { name: "Second", programme: null, projectId: null, url: null, position: 5 },
      { name: "British Library", programme: "Endangered Archives Programme", projectId: "EAP 1477", url: "https://eap.bl.uk/project/EAP1477", position: 0 },
    ];
    const out = buildRepositoryRecord(repo(), funders, extras, BASE, null);
    expect(out.funders).toEqual([
      { name: "British Library", programme: "Endangered Archives Programme", project_id: "EAP 1477", url: "https://eap.bl.uk/project/EAP1477" },
      { name: "Second", programme: null, project_id: null, url: null },
    ]);
    expect(Object.keys(out.funders[0])).toEqual(["name", "programme", "project_id", "url"]);
  });

  it("leaves out a funder whose name is blank", () => {
    const funders: FunderSource[] = [
      { name: " ", programme: "Programme", projectId: "P 1", url: null, position: 0 },
      { name: "Kept", programme: null, projectId: null, url: null, position: 1 },
    ];
    expect(buildRepositoryRecord(repo(), funders, extras, BASE, null).funders).toEqual([
      { name: "Kept", programme: null, project_id: null, url: null },
    ]);
  });

  it("composes the line from name, place, credit statement and licence label", () => {
    const r = repo({
      name: "Archivo Histórico Regional de Boyacá",
      city: "Tunja",
      region: "Boyacá",
      country: "Colombia",
      creditStatementEs: "Digitalizado en alianza con Neogranadina.",
      creditStatementEn: "Digitized in partnership with Neogranadina.",
      manifestRights: "http://creativecommons.org/licenses/by-nc/4.0/",
    });
    const expected = {
      es: "Archivo Histórico Regional de Boyacá, Tunja, Boyacá, Colombia. Digitalizado en alianza con Neogranadina. CC BY-NC 4.0.",
      en: "Archivo Histórico Regional de Boyacá, Tunja, Boyacá, Colombia. Digitized in partnership with Neogranadina. CC BY-NC 4.0.",
    };
    expect(composeAttribution(r, null)).toEqual(expected);
    expect(buildRepositoryRecord(r, [], extras, BASE, null).attribution).toEqual(expected);
  });

  it("joins only the place parts present", () => {
    expect(composeAttribution(repo({ region: null }), null).es).toBe("Centro de Investigaciones Históricas, Popayán, Colombia.");
    expect(composeAttribution(repo({ city: null, region: null, country: null }), null).es).toBe("Centro de Investigaciones Históricas.");
    expect(composeAttribution(repo({ city: null, country: null }), null).en).toBe("Centro de Investigaciones Históricas, Cauca.");
  });

  it("uses the statement exactly as written, adding no punctuation", () => {
    const out = composeAttribution(repo({
      creditStatementEs: "Digitalizado por Neogranadina",
      manifestRights: "https://creativecommons.org/publicdomain/zero/1.0/",
    }), null);
    expect(out.es).toBe(`${PLACE} Digitalizado por Neogranadina CC0 1.0.`);
  });

  it("writes a statement without a licence when the label is unknown or the URI absent", () => {
    const withStatement = { creditStatementEs: "Con el apoyo de X.", creditStatementEn: "With support from X." };
    expect(composeAttribution(repo(withStatement), null)).toEqual({
      es: `${PLACE} Con el apoyo de X.`,
      en: `${PLACE} With support from X.`,
    });
    expect(composeAttribution(repo({ ...withStatement, manifestRights: "https://example.org/licence" }), null).es)
      .toBe(`${PLACE} Con el apoyo de X.`);
  });

  it("writes the licence label in both languages, without a statement", () => {
    expect(composeAttribution(repo({ manifestRights: "https://creativecommons.org/licenses/by/4.0/" }), null)).toEqual({
      es: `${PLACE} CC BY 4.0.`,
      en: `${PLACE} CC BY 4.0.`,
    });
  });

  it("never borrows the Spanish statement for the English line", () => {
    const out = composeAttribution(repo({ creditStatementEs: "Digitalizado por Neogranadina.", creditStatementEn: null }), null);
    expect(out).toEqual({ es: `${PLACE} Digitalizado por Neogranadina.`, en: PLACE });
  });

  it("reads blank statements, place parts and licences as absent", () => {
    const out = composeAttribution(repo({
      city: " ", region: "", country: "\t", creditStatementEs: "  ", creditStatementEn: "", manifestRights: " ",
    }), null);
    expect(out).toEqual({ es: "Centro de Investigaciones Históricas.", en: "Centro de Investigaciones Históricas." });
  });

  it("is null in a language with nothing to compose", () => {
    expect(composeAttribution(repo({ name: " ", city: null, region: null, country: null }), null)).toEqual(NULLS);
    expect(composeAttribution(repo({ name: "", city: null, region: null, country: null, creditStatementEn: "Digitized by X." }), null))
      .toEqual({ es: null, en: "Digitized by X." });
  });

  it("uses a stored override in place of the composed line, one language at a time", () => {
    expect(buildRepositoryRecord(repo({ attributionEs: "Atribución", attributionEn: "Attribution" }), [], extras, BASE, null).attribution)
      .toEqual({ es: "Atribución", en: "Attribution" });
    expect(buildRepositoryRecord(repo({ attributionEs: "Atribución" }), [], extras, BASE, null).attribution)
      .toEqual({ es: "Atribución", en: PLACE });
    expect(buildRepositoryRecord(repo({ attributionEn: "Attribution", attributionEs: "  " }), [], extras, BASE, null).attribution)
      .toEqual({ es: PLACE, en: "Attribution" });
  });
});

describe("the hosting statement in the attribution line", () => {
  const extras = { descriptionCount: 0, rootDescriptions: [] };
  const HOSTING = { hostingStatementEs: "Alojado en Zasqua (zasqua.org).", hostingStatementEn: "Hosted on Zasqua (zasqua.org)." };
  const CREDIT = { creditStatementEs: "Digitalizado en alianza con Neogranadina.", creditStatementEn: "Digitized in partnership with Neogranadina." };
  const BY_NC = "http://creativecommons.org/licenses/by-nc/4.0/";

  it("follows the credit statement and precedes the licence label, as written", () => {
    expect(composeAttribution(repo({ ...CREDIT, manifestRights: BY_NC }), HOSTING)).toEqual({
      es: `${PLACE} Digitalizado en alianza con Neogranadina. Alojado en Zasqua (zasqua.org). CC BY-NC 4.0.`,
      en: `${PLACE} Digitized in partnership with Neogranadina. Hosted on Zasqua (zasqua.org). CC BY-NC 4.0.`,
    });
  });

  it("follows the place when there is no credit statement, and ends the line when there is no licence", () => {
    expect(composeAttribution(repo(), HOSTING)).toEqual({
      es: `${PLACE} Alojado en Zasqua (zasqua.org).`,
      en: `${PLACE} Hosted on Zasqua (zasqua.org).`,
    });
  });

  it("adds no punctuation to the statement", () => {
    expect(composeAttribution(repo({ manifestRights: BY_NC }), { hostingStatementEs: "Alojado en Zasqua", hostingStatementEn: null }).es)
      .toBe(`${PLACE} Alojado en Zasqua CC BY-NC 4.0.`);
  });

  it("gives a federation without one the line without it", () => {
    const r = repo({ ...CREDIT, manifestRights: BY_NC });
    const without = {
      es: `${PLACE} Digitalizado en alianza con Neogranadina. CC BY-NC 4.0.`,
      en: `${PLACE} Digitized in partnership with Neogranadina. CC BY-NC 4.0.`,
    };
    expect(composeAttribution(r, null)).toEqual(without);
    expect(composeAttribution(r, { hostingStatementEs: null, hostingStatementEn: null })).toEqual(without);
    expect(composeAttribution(r, { hostingStatementEs: "  ", hostingStatementEn: "" })).toEqual(without);
  });

  it("never borrows the statement of the other language", () => {
    expect(composeAttribution(repo(), { hostingStatementEs: "Alojado en Zasqua (zasqua.org).", hostingStatementEn: null })).toEqual({
      es: `${PLACE} Alojado en Zasqua (zasqua.org).`,
      en: PLACE,
    });
    expect(composeAttribution(repo(), { hostingStatementEs: null, hostingStatementEn: "Hosted on Zasqua (zasqua.org)." })).toEqual({
      es: PLACE,
      en: `${PLACE} Hosted on Zasqua (zasqua.org).`,
    });
  });

  it("is the whole line in a language with no other part", () => {
    expect(composeAttribution(repo({ name: " ", city: null, region: null, country: null }), HOSTING)).toEqual({
      es: "Alojado en Zasqua (zasqua.org).",
      en: "Hosted on Zasqua (zasqua.org).",
    });
  });

  it("is left out where an override wins, one language at a time", () => {
    const r = repo({ ...CREDIT, attributionEn: "Hand-written line." });
    expect(repositoryAttribution(r, HOSTING)).toEqual({
      es: `${PLACE} Digitalizado en alianza con Neogranadina. Alojado en Zasqua (zasqua.org).`,
      en: "Hand-written line.",
    });
  });

  it("reaches the exported record's attribution", () => {
    expect(buildRepositoryRecord(repo({ manifestRights: BY_NC }), [], extras, BASE, HOSTING).attribution).toEqual({
      es: `${PLACE} Alojado en Zasqua (zasqua.org). CC BY-NC 4.0.`,
      en: `${PLACE} Hosted on Zasqua (zasqua.org). CC BY-NC 4.0.`,
    });
  });

  it("keeps image_reproduction_text as rights_text, an empty string when null", () => {
    expect(buildRepositoryRecord(repo({ rightsText: "Texto de derechos." }), [], extras, BASE, null).image_reproduction_text)
      .toBe("Texto de derechos.");
    expect(buildRepositoryRecord(repo({ rightsText: null }), [], extras, BASE, null).image_reproduction_text).toBe("");
  });

  it("exports blank text as null, flat fields and contact included", () => {
    const blanks: Partial<RepositorySource> = {};
    for (const k of [
      "shortName", "countryCode", "country", "city", "address", "website", "displayTitle",
      "subtitle", "subtitleEn", "heroImageUrl", "institutionType", "logoKey", "region",
      "postalCode", "telephone", "email", "holdingsEs", "holdingsEn", "historyEs", "historyEn",
      "openingTimesEs", "openingTimesEn", "accessConditionsEs", "accessConditionsEn",
      "accessibilityEs", "accessibilityEn", "reproductionServicesEs", "reproductionServicesEn",
      "manifestRights", "catalogueLicenceUri", "attributionEs", "attributionEn", "descriptionLanguage",
    ] as const) {
      (blanks as Record<string, string>)[k] = " \t ";
    }
    blanks.address = "";
    const out = buildRepositoryRecord(
      repo(blanks),
      [{ name: "Funder", programme: " ", projectId: "", url: "  ", position: 0 }],
      extras,
      BASE,
      null,
    );
    expect(out.short_name).toBeNull();
    expect(out.display_title).toBeNull();
    expect(out.subtitle).toEqual(NULLS);
    expect(out.hero_image_url).toBeNull();
    expect(out.institution_type).toBeNull();
    expect(out.logo_url).toBeNull();
    expect(out.contact).toEqual({
      street_address: null, city: null, region: null, country: null, country_code: null,
      postal_code: null, telephone: null, email: null, website: null,
    });
    expect([out.city, out.country, out.country_code, out.address, out.website]).toEqual([null, null, null, null, null]);
    expect(out.holdings).toEqual(NULLS);
    expect(out.history).toEqual(NULLS);
    expect(out.access).toEqual({ opening_times: NULLS, conditions: NULLS, accessibility: NULLS });
    expect(out.reproduction_services).toEqual(NULLS);
    expect(out.image_licence).toEqual({ uri: null, label: NULLS });
    expect(out.catalogue_licence).toEqual({ uri: null, label: NULLS });
    expect(out.attribution).toEqual({ es: "Centro de Investigaciones Históricas.", en: "Centro de Investigaciones Históricas." });
    expect(out.description_language).toBeNull();
    expect(out.funders).toEqual([{ name: "Funder", programme: null, project_id: null, url: null }]);
  });

  it("reads a timestamp below 1e11 as seconds and any other as milliseconds", () => {
    const seconds = Math.floor(Date.UTC(2025, 11, 1, 10, 0, 0) / 1000);
    const millis = Date.UTC(2026, 10, 3, 4, 2, 11, 431);
    const out = buildRepositoryRecord(repo({ createdAt: seconds, updatedAt: millis }), [], extras, BASE, null);
    expect(out.created_at).toBe("2025-12-01T10:00:00.000Z");
    expect(out.updated_at).toBe("2026-11-03T04:02:11.431Z");
    const edge = buildRepositoryRecord(repo({ createdAt: 1e11 - 1, updatedAt: 1e11 }), [], extras, BASE, null);
    expect(edge.created_at).toBe(new Date((1e11 - 1) * 1000).toISOString());
    expect(edge.updated_at).toBe(new Date(1e11).toISOString());
  });

  it("passes the count and root descriptions through", () => {
    const roots = [{ id: "d1" }] as unknown as Parameters<typeof buildRepositoryRecord>[2]["rootDescriptions"];
    const out = buildRepositoryRecord(repo(), [], { descriptionCount: 3, rootDescriptions: roots }, BASE, null);
    expect(out.description_count).toBe(3);
    expect(out.root_descriptions).toBe(roots);
  });
});

describe("the country name in the English attribution line", () => {
  const extras = { descriptionCount: 0, rootDescriptions: [] };
  const LIMA = { name: "Biblioteca Nacional del Perú", city: "Lima", region: null, country: "Perú" };

  it("names the country in English from an alpha-2 code, and Perú in Spanish", () => {
    expect(composeAttribution(repo({ ...LIMA, countryCode: "PE" }), null)).toEqual({
      es: "Biblioteca Nacional del Perú, Lima, Perú.",
      en: "Biblioteca Nacional del Perú, Lima, Peru.",
    });
  });

  it("names the country in English from the stored alpha-3 code", () => {
    expect(composeAttribution(repo({ ...LIMA, countryCode: "PER" }), null)).toEqual({
      es: "Biblioteca Nacional del Perú, Lima, Perú.",
      en: "Biblioteca Nacional del Perú, Lima, Peru.",
    });
    expect(composeAttribution(repo({ ...LIMA, countryCode: "per" }), null).en).toBe("Biblioteca Nacional del Perú, Lima, Peru.");
  });

  it("names Colombia from CO and from COL", () => {
    expect(composeAttribution(repo({ countryCode: "CO" }), null)).toEqual({ es: PLACE, en: PLACE });
    expect(composeAttribution(repo({ countryCode: "COL" }), null)).toEqual({ es: PLACE, en: PLACE });
  });

  it("keeps the stored country when there is no code", () => {
    for (const countryCode of [null, "", "  "]) {
      expect(composeAttribution(repo({ ...LIMA, countryCode }), null).en).toBe("Biblioteca Nacional del Perú, Lima, Perú.");
    }
  });

  it("keeps the stored country when the code names no country", () => {
    for (const countryCode of ["XX", "QQQ", "PERU", "P1", "604"]) {
      expect(composeAttribution(repo({ ...LIMA, countryCode }), null).en).toBe("Biblioteca Nacional del Perú, Lima, Perú.");
    }
  });

  it("adds no country from the code when none is stored", () => {
    expect(composeAttribution(repo({ ...LIMA, country: null, countryCode: "PER" }), null)).toEqual({
      es: "Biblioteca Nacional del Perú, Lima.",
      en: "Biblioteca Nacional del Perú, Lima.",
    });
  });

  it("reaches the exported record's attribution, and leaves an override as written", () => {
    expect(buildRepositoryRecord(repo({ ...LIMA, countryCode: "PER" }), [], extras, BASE, null).attribution).toEqual({
      es: "Biblioteca Nacional del Perú, Lima, Perú.",
      en: "Biblioteca Nacional del Perú, Lima, Peru.",
    });
    expect(repositoryAttribution(repo({ ...LIMA, countryCode: "PER", attributionEn: "Lima, Perú." }), null).en).toBe("Lima, Perú.");
  });
});

describe("the country name in the Spanish attribution line", () => {
  const NARA = { name: "National Archives", city: "Washington", region: null, country: "United States" };
  const LIMA = { name: "Biblioteca Nacional del Perú", city: "Lima", region: null, country: "Perú" };

  it("names the country in Spanish from an alpha-3 or alpha-2 code", () => {
    expect(composeAttribution(repo({ ...NARA, countryCode: "USA" }), null)).toEqual({
      es: "National Archives, Washington, Estados Unidos.",
      en: "National Archives, Washington, United States.",
    });
    expect(composeAttribution(repo({ ...NARA, countryCode: "US" }), null).es).toBe("National Archives, Washington, Estados Unidos.");
  });

  it("names Colombia and Perú as the stored names do", () => {
    expect(composeAttribution(repo({ countryCode: "COL" }), null).es).toBe(PLACE);
    expect(composeAttribution(repo({ ...LIMA, countryCode: "PER" }), null).es).toBe("Biblioteca Nacional del Perú, Lima, Perú.");
  });

  it("keeps the stored country when there is no code or the code names no country", () => {
    for (const countryCode of [null, "", "  ", "XX", "QQQ"]) {
      expect(composeAttribution(repo({ ...NARA, countryCode }), null).es).toBe("National Archives, Washington, United States.");
    }
  });

  it("adds no country from the code when the stored country is blank", () => {
    for (const country of [null, "", "  "]) {
      expect(composeAttribution(repo({ ...NARA, country, countryCode: "USA" }), null).es).toBe("National Archives, Washington.");
    }
  });
});

describe("buildVocabularyJson", () => {
  let n = 0;
  function value(over: Partial<VocabularyValueSource>): VocabularyValueSource {
    n++;
    return {
      list: "entity_type",
      code: `c${n}`,
      labelEs: null,
      labelEn: null,
      groupCode: null,
      position: 0,
      externalScheme: null,
      externalUri: null,
      externalLabel: null,
      status: "approved",
      ...over,
    };
  }
  function source(over: Partial<AuthoritySourceSource>): AuthoritySourceSource {
    return { key: "viaf", labelEs: "VIAF", labelEn: "VIAF", urlTemplate: "https://viaf.org/viaf/{id}", appliesTo: '["entity"]', position: 0, status: "approved", ...over };
  }

  it("writes the sections in the contract order, empty when there are no rows", () => {
    const out = buildVocabularyJson([], []);
    expect(Object.keys(out)).toEqual([
      "entity_types", "place_types", "role_groups", "entity_roles", "place_roles", "authority_sources",
      "relation_roles", "link_attributes", "genders",
    ]);
    expect(Object.values(out).every((s) => Array.isArray(s) && s.length === 0)).toBe(true);
  });

  it("sorts each list into its section, with the section's own keys", () => {
    const out = buildVocabularyJson(
      [
        value({ list: "entity_type", code: "person", labelEs: "Persona", labelEn: "Person" }),
        value({ list: "place_type", code: "town", labelEs: "Pueblo", labelEn: "Town" }),
        value({ list: "role_group", code: "parties", labelEs: "Partes", labelEn: "Parties", position: 2 }),
        value({ list: "entity_role", code: "defendant", labelEs: "Demandado", labelEn: "Defendant", groupCode: "parties" }),
        value({ list: "place_role", code: "origin", labelEs: "Origen", labelEn: null }),
      ],
      [],
    );
    expect(out.entity_types).toEqual([{ code: "person", label: { es: "Persona", en: "Person" } }]);
    expect(out.place_types).toEqual([{ code: "town", label: { es: "Pueblo", en: "Town" } }]);
    expect(out.role_groups).toEqual([{ code: "parties", label: { es: "Partes", en: "Parties" }, order: 2 }]);
    expect(out.entity_roles).toEqual([{ code: "defendant", label: { es: "Demandado", en: "Defendant" }, group: "parties" }]);
    expect(out.place_roles).toEqual([{ code: "origin", label: { es: "Origen", en: null } }]);
    expect(Object.keys(out.role_groups[0])).toEqual(["code", "label", "order"]);
    expect(Object.keys(out.entity_roles[0])).toEqual(["code", "label", "group"]);
  });

  it("writes `external` only when a place type has an external URI", () => {
    const out = buildVocabularyJson(
      [
        value({ list: "place_type", code: "river", position: 1, externalScheme: "aat", externalUri: "http://vocab.getty.edu/aat/300008707", externalLabel: "rivers" }),
        value({ list: "place_type", code: "hacienda", position: 2, externalScheme: "aat", externalUri: null, externalLabel: "haciendas" }),
      ],
      [],
    );
    expect(out.place_types[0]).toEqual({
      code: "river",
      label: NULLS,
      external: { scheme: "aat", uri: "http://vocab.getty.edu/aat/300008707", label: "rivers" },
    });
    expect(Object.keys(out.place_types[0].external!)).toEqual(["scheme", "uri", "label"]);
    expect(out.place_types[1]).not.toHaveProperty("external");
  });

  it("orders by position, then code", () => {
    const out = buildVocabularyJson(
      [
        value({ list: "entity_type", code: "b", position: 1 }),
        value({ list: "entity_type", code: "z", position: 0 }),
        value({ list: "entity_type", code: "a", position: 1 }),
      ],
      [],
    );
    expect(out.entity_types.map((v) => v.code)).toEqual(["z", "a", "b"]);
  });

  it("leaves out proposed values and sources, and marks deprecated ones", () => {
    const out = buildVocabularyJson(
      [
        value({ list: "entity_type", code: "ok", position: 0 }),
        value({ list: "entity_type", code: "maybe", status: "proposed", position: 1 }),
        value({ list: "entity_type", code: "old", status: "deprecated", position: 2 }),
        value({ list: "place_type", code: "mine", status: "deprecated", externalUri: "http://vocab.getty.edu/aat/1", externalScheme: "aat", externalLabel: "mines" }),
        value({ list: "role_group", code: "g", status: "deprecated", position: 4 }),
        value({ list: "entity_role", code: "r", status: "deprecated", groupCode: "g" }),
        value({ list: "place_role", code: "p", status: "deprecated" }),
      ],
      [
        source({ key: "viaf", position: 0 }),
        source({ key: "old", status: "deprecated", position: 1 }),
        source({ key: "new", status: "proposed", position: 2 }),
      ],
    );
    expect(out.entity_types).toEqual([
      { code: "ok", label: NULLS },
      { code: "old", label: NULLS, deprecated: true },
    ]);
    expect(out.entity_types[0]).not.toHaveProperty("deprecated");
    expect(Object.keys(out.place_types[0])).toEqual(["code", "label", "external", "deprecated"]);
    expect(out.role_groups[0]).toEqual({ code: "g", label: NULLS, order: 4, deprecated: true });
    expect(out.entity_roles[0]).toEqual({ code: "r", label: NULLS, group: "g", deprecated: true });
    expect(out.place_roles[0]).toEqual({ code: "p", label: NULLS, deprecated: true });
    expect(out.authority_sources.map((s) => s.key)).toEqual(["viaf", "old"]);
    expect(out.authority_sources[0]).not.toHaveProperty("deprecated");
    expect(out.authority_sources[1].deprecated).toBe(true);
    expect(Object.keys(out.authority_sources[1])).toEqual(["key", "label", "url_template", "applies_to", "deprecated"]);
  });

  it("exports blank labels, templates and external terms as null", () => {
    const out = buildVocabularyJson(
      [
        value({ list: "place_type", code: "x", labelEs: "  ", labelEn: "", externalUri: "http://vocab.getty.edu/aat/2", externalScheme: " ", externalLabel: "\t" }),
        value({ list: "place_type", code: "y", position: 1, externalUri: "   ", externalLabel: "label" }),
        value({ list: "entity_role", code: "r", groupCode: " " }),
      ],
      [source({ key: "k", labelEs: " ", labelEn: "", urlTemplate: "  " })],
    );
    expect(out.place_types[0]).toEqual({ code: "x", label: NULLS, external: { scheme: null, uri: "http://vocab.getty.edu/aat/2", label: null } });
    expect(out.place_types[1]).not.toHaveProperty("external");
    expect(out.entity_roles[0].group).toBeNull();
    expect(out.authority_sources[0].label).toEqual(NULLS);
    expect(out.authority_sources[0].url_template).toBeNull();
  });

  it("writes authority sources in position order, with applies_to parsed", () => {
    const out = buildVocabularyJson(
      [],
      [
        source({ key: "wikidata", labelEs: "Wikidata", labelEn: "Wikidata", urlTemplate: "https://www.wikidata.org/wiki/{id}", appliesTo: '["entity","place"]', position: 2 }),
        source({ key: "viaf", position: 1 }),
        source({ key: "tgn", labelEn: null, urlTemplate: null, appliesTo: null, position: 3 }),
        source({ key: "broken", appliesTo: "not json", position: 4 }),
      ],
    );
    expect(out.authority_sources).toEqual([
      { key: "viaf", label: { es: "VIAF", en: "VIAF" }, url_template: "https://viaf.org/viaf/{id}", applies_to: ["entity"] },
      { key: "wikidata", label: { es: "Wikidata", en: "Wikidata" }, url_template: "https://www.wikidata.org/wiki/{id}", applies_to: ["entity", "place"] },
      { key: "tgn", label: { es: "VIAF", en: null }, url_template: null, applies_to: [] },
      { key: "broken", label: { es: "VIAF", en: "VIAF" }, url_template: "https://viaf.org/viaf/{id}", applies_to: [] },
    ]);
    expect(Object.keys(out.authority_sources[0])).toEqual(["key", "label", "url_template", "applies_to"]);
  });

  /** A relation role as the vocabulary seed stores one. */
  function relation(code: string, over: Partial<VocabularyValueSource> = {}): VocabularyValueSource {
    return value({
      list: "relation_role",
      code,
      labelEs: `${code} u`,
      labelEn: `${code} U`,
      labelEsFemale: `${code} f`,
      labelEsMale: `${code} m`,
      labelEsUnrecorded: `${code} u`,
      labelEsAlone: null,
      labelEnFemale: `${code} F`,
      labelEnMale: `${code} M`,
      labelEnUnrecorded: `${code} U`,
      labelEnAlone: null,
      connectorEs: "de",
      connectorEn: "of",
      inverseCode: code,
      ...over,
    });
  }

  it("writes each relation role's four forms, connector, inverse and group, in group then value order", () => {
    const out = buildVocabularyJson(
      [
        value({ list: "role_group", code: "g2", position: 2 }),
        value({ list: "role_group", code: "g1", position: 1 }),
        relation("b", { groupCode: "g2", position: 1, inverseCode: "a" }),
        relation("c", { groupCode: "g1", position: 2 }),
        relation("a", { groupCode: "g1", position: 1, inverseCode: "b", labelEsAlone: "a sola", labelEnAlone: "a alone" }),
      ],
      [],
    );
    expect(out.relation_roles.map((r) => r.code)).toEqual(["a", "c", "b"]);
    expect(out.relation_roles[0]).toEqual({
      code: "a",
      label: {
        es: { female: "a f", male: "a m", unrecorded: "a u", alone: "a sola" },
        en: { female: "a F", male: "a M", unrecorded: "a U", alone: "a alone" },
      },
      connector: { es: "de", en: "of" },
      inverse: "b",
      group: "g1",
    });
    expect(Object.keys(out.relation_roles[0])).toEqual(["code", "label", "connector", "inverse", "group"]);
    expect(Object.keys(out.relation_roles[0].label.es)).toEqual(["female", "male", "unrecorded", "alone"]);
    expect(out.relation_roles[1].label.es).not.toHaveProperty("alone");
  });

  it("gives `alone` only where it is stored and differs from the unrecorded form, one language at a time", () => {
    const out = buildVocabularyJson(
      [
        relation("same", { labelEsAlone: "same u", labelEnAlone: "same alone" }),
        relation("blank", { position: 1, labelEsAlone: " ", labelEnAlone: "" }),
      ],
      [],
    );
    expect(out.relation_roles[0].label.es).not.toHaveProperty("alone");
    expect(out.relation_roles[0].label.en.alone).toBe("same alone");
    expect(out.relation_roles[1].label.es).not.toHaveProperty("alone");
    expect(out.relation_roles[1].label.en).not.toHaveProperty("alone");
  });

  it("writes a missing connector, inverse or group as null", () => {
    const out = buildVocabularyJson(
      [relation("x", { connectorEs: null, connectorEn: " ", inverseCode: null, groupCode: null })],
      [],
    );
    expect(out.relation_roles[0].connector).toEqual({ es: null, en: null });
    expect(out.relation_roles[0].inverse).toBeNull();
    expect(out.relation_roles[0].group).toBeNull();
  });

  it("orders a relation role whose group is not listed after the listed groups", () => {
    const out = buildVocabularyJson(
      [
        value({ list: "role_group", code: "g1", position: 1 }),
        relation("orphan", { groupCode: "missing", position: 0 }),
        relation("listed", { groupCode: "g1", position: 5 }),
      ],
      [],
    );
    expect(out.relation_roles.map((r) => r.code)).toEqual(["listed", "orphan"]);
  });

  it("writes link attributes in position order with their stored order and hide_when_group", () => {
    const out = buildVocabularyJson(
      [
        value({ list: "link_attribute", code: "condition", labelEs: "Condición", labelEn: "Condition", position: 3, hideWhenGroup: "enslavement" }),
        value({ list: "link_attribute", code: "office", labelEs: "Cargo", labelEn: "Office", position: 1 }),
      ],
      [],
    );
    expect(out.link_attributes).toEqual([
      { key: "office", label: { es: "Cargo", en: "Office" }, order: 1, hide_when_group: null },
      { key: "condition", label: { es: "Condición", en: "Condition" }, order: 3, hide_when_group: "enslavement" },
    ]);
    expect(Object.keys(out.link_attributes[0])).toEqual(["key", "label", "order", "hide_when_group"]);
  });

  it("writes genders in the shape of the other simple lists", () => {
    const out = buildVocabularyJson(
      [
        value({ list: "gender", code: "male", labelEs: "Hombre", labelEn: "Man", position: 2 }),
        value({ list: "gender", code: "female", labelEs: "Mujer", labelEn: "Woman", position: 1 }),
        value({ list: "gender", code: "other", position: 3, status: "deprecated" }),
        value({ list: "gender", code: "maybe", position: 4, status: "proposed" }),
      ],
      [],
    );
    expect(out.genders).toEqual([
      { code: "female", label: { es: "Mujer", en: "Woman" } },
      { code: "male", label: { es: "Hombre", en: "Man" } },
      { code: "other", label: NULLS, deprecated: true },
    ]);
  });

  it("leaves out proposed relation roles and attributes, and marks deprecated ones", () => {
    const out = buildVocabularyJson(
      [
        relation("old", { status: "deprecated" }),
        relation("new", { status: "proposed", position: 1 }),
        value({ list: "link_attribute", code: "a", status: "deprecated" }),
        value({ list: "link_attribute", code: "b", status: "proposed", position: 1 }),
      ],
      [],
    );
    expect(out.relation_roles.map((r) => [r.code, r.deprecated ?? false])).toEqual([["old", true]]);
    expect(out.link_attributes.map((a) => [a.key, a.deprecated ?? false])).toEqual([["a", true]]);
  });

  it("writes labels exactly as stored, case included", () => {
    const out = buildVocabularyJson(
      [
        value({ list: "role_group", code: "enslaved_ties", labelEs: "Vínculos entre personas esclavizadas", labelEn: "Ties among enslaved people" }),
        relation("testator", { labelEnFemale: "testator", labelEnMale: "testator", labelEnUnrecorded: "testator", connectorEn: "who appointed" }),
        relation("ward", { position: 1, labelEsUnrecorded: "menor", labelEsAlone: "menor bajo tutela o curaduría" }),
      ],
      [],
    );
    expect(out.role_groups[0].label.es).toBe("Vínculos entre personas esclavizadas");
    expect(out.relation_roles[0].connector.en).toBe("who appointed");
    expect(out.relation_roles[1].label.es.alone).toBe("menor bajo tutela o curaduría");
  });
});

// @version v0.9.0
