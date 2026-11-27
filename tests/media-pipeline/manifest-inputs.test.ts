/**
 * Tests — media pipeline manifest inputs
 *
 * This suite pins the resolver that builds each volume's `manifest`
 * block from the description, its repository and the tenant:
 *
 *   - with the values the seeding command plans for the Neogranadina
 *     tenant and its repositories, the block built from two production
 *     rows (copied into `tests/fixtures/manifest-inputs/`, with the Date
 *     the published manifest carries) serialises, field by field, to the
 *     bytes of the manifest published for that description;
 *   - the metadata rule: empty values left out, a repository without a
 *     city, a value holding `|` split, a migrated language code read as
 *     Spanish;
 *   - a tenant with none of the five settings gets no homepage, an empty
 *     provider and no METS link;
 *   - a repository without rights is refused naming it;
 *   - the required statement is the attribution line the export uses:
 *     the stored override where there is one, else the line composed
 *     from the repository and the federation's hosting statement, per
 *     language; only the languages with a line are written;
 *   - publishing's locator maps the resolver's id to the key promotion
 *     writes.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import ahrb from "../fixtures/manifest-inputs/co-ahrb-aht-008.json";
import bn from "../fixtures/manifest-inputs/pe-bn-cdip-00149.json";
import {
  manifestMetadata,
  manifestResolver,
  resolveManifestInputs,
  type ManifestDescription,
  type ManifestRepository,
  type ManifestTenant,
} from "../../app/lib/pipeline/manifest-inputs";
import { ManifestInputsError } from "../../app/lib/pipeline/run-spec";
import { prefixLocator } from "../../app/lib/pipeline/canonical.server";
import {
  NEOGRANADINA_MANIFEST_TENANT,
  seededRepositoryValues,
} from "../../scripts/lib/manifest-seed";

const BASE = "https://manifests.zasqua.org";

const EMPTY_TENANT: ManifestTenant = {
  publicSiteUrl: null,
  publicSiteName: null,
  providerName: null,
  providerUrl: null,
  metsBaseUrl: null,
};

interface Fixture {
  description: ManifestDescription;
  repository: { id: string; code: string; name: string; city: string | null; country: string | null };
  published: Record<string, unknown>;
}

function seededRepository(f: Fixture): ManifestRepository {
  const values = seededRepositoryValues(f.repository);
  if (!values) throw new Error(`no seed values for ${f.repository.code}`);
  return { region: null, countryCode: null, creditStatementEs: null, creditStatementEn: null, ...f.repository, ...values };
}

function resolved(f: Fixture) {
  return resolveManifestInputs(
    BASE,
    f.description.referenceCode,
    f.description,
    seededRepository(f),
    NEOGRANADINA_MANIFEST_TENANT,
    null,
  );
}

const ser = (x: unknown) => JSON.stringify(x);

// Spec field, published manifest field.
const FIELDS = [
  ["id", "id"],
  ["label", "label"],
  ["homepage", "homepage"],
  ["rights", "rights"],
  ["required_statement", "requiredStatement"],
  ["provider", "provider"],
  ["see_also", "seeAlso"],
  ["metadata", "metadata"],
  ["summary", "summary"],
] as const;

describe("manifest inputs against the published manifests", () => {
  const fixtures: Array<[string, Fixture]> = [
    ["co-ahrb-aht-008", ahrb as Fixture],
    ["pe-bn-cdip-00149", bn as Fixture],
  ];
  // The production row of pe-bn-cdip-00149 gained a language code and a
  // scope and content note after its manifest was published; the two
  // fields are checked against the row below.
  const differs = new Set(["pe-bn-cdip-00149:metadata", "pe-bn-cdip-00149:summary"]);

  for (const [ref, f] of fixtures) {
    for (const [specKey, manifestKey] of FIELDS) {
      if (differs.has(`${ref}:${specKey}`)) continue;
      const name = `${ref}: ${specKey} serialises to the published ${manifestKey}`;
      it(name, () => {
        const block = resolved(f) as Record<string, unknown>;
        expect(ser(block[specKey])).toBe(ser(f.published[manifestKey]));
      });
    }
  }

  it("pe-bn-cdip-00149 differs only by the Language entry its row gained", () => {
    const f = bn as Fixture;
    const metadata = resolved(f).metadata!;
    const published = f.published.metadata as unknown[];
    const language = { label: { en: ["Language"], es: ["Idioma"] }, value: { es: ["Español"] } };
    expect(metadata[1]).toEqual(language);
    expect(ser([metadata[0], ...metadata.slice(2)])).toBe(ser(published));
  });

  it("pe-bn-cdip-00149 carries the scope and content note its row gained as summary", () => {
    const f = bn as Fixture;
    expect(f.published.summary).toBeUndefined();
    expect(resolved(f).summary).toEqual({ es: [f.description.scopeContent] });
  });

  it("co-ahrb-aht-008 differs only in Date when built from the stored date", () => {
    const f = ahrb as Fixture & { storedDateExpression: string };
    const stored = resolveManifestInputs(
      BASE,
      f.description.referenceCode,
      { ...f.description, dateExpression: f.storedDateExpression },
      seededRepository(f),
      NEOGRANADINA_MANIFEST_TENANT,
      null,
    );
    const published = f.published.metadata as unknown[];
    expect(stored.metadata![0]).toEqual({
      label: { en: ["Date"], es: ["Fecha"] },
      value: { es: ["1570 .. 1572"] },
    });
    expect(ser(stored.metadata!.slice(1))).toBe(ser(published.slice(1)));
  });
});

function description(over: Partial<ManifestDescription> = {}): ManifestDescription {
  return {
    referenceCode: "co-x-001",
    title: "Test title",
    dateExpression: null,
    extent: null,
    language: null,
    accessConditions: null,
    scopeContent: null,
    ...over,
  };
}

function repository(over: Partial<ManifestRepository> = {}): ManifestRepository {
  return {
    id: "repo-1",
    code: "co-x",
    name: "Test repository",
    city: null,
    region: null,
    country: null,
    countryCode: null,
    manifestRights: "https://rights.example.test/",
    creditStatementEs: null,
    creditStatementEn: null,
    attributionEn: null,
    attributionEs: null,
    ...over,
  };
}

describe("manifest metadata", () => {
  it("leaves out empty values and keeps the order", () => {
    const m = manifestMetadata(
      description({ dateExpression: "", extent: "2 folios", language: null, accessConditions: "Libre" }),
      { name: "Test repository", city: null },
    );
    expect(m.map((e) => e.label.en[0])).toEqual(["Extent", "Access conditions", "Reference", "Repository"]);
  });

  it("names a repository without a city by its name alone, and with one as name, city", () => {
    expect(manifestMetadata(description(), { name: "Archivo", city: null }).at(-1)!.value).toEqual({ es: ["Archivo"] });
    expect(manifestMetadata(description(), { name: "Archivo", city: "" }).at(-1)!.value).toEqual({ es: ["Archivo"] });
    expect(manifestMetadata(description(), { name: "Archivo", city: "Tunja" }).at(-1)!.value).toEqual({
      es: ["Archivo, Tunja"],
    });
  });

  it("splits a value holding | into several values", () => {
    const m = manifestMetadata(description({ extent: "2 folios | 1 mapa|3 hojas" }), { name: "A", city: null });
    expect(m[0]).toEqual({
      label: { en: ["Extent"], es: ["Extensión"] },
      value: { es: ["2 folios", "1 mapa", "3 hojas"] },
    });
  });

  it("reads the migrated language codes as Spanish and keeps any other value as stored", () => {
    for (const code of ["192", "173", "195", "Spanish"]) {
      const m = manifestMetadata(description({ language: code }), { name: "A", city: null });
      expect(m[0]).toEqual({ label: { en: ["Language"], es: ["Idioma"] }, value: { es: ["Español"] } });
    }
    const latin = manifestMetadata(description({ language: "Latín" }), { name: "A", city: null });
    expect(latin[0].value).toEqual({ es: ["Latín"] });
  });

  it("writes Date as stored", () => {
    const m = manifestMetadata(description({ dateExpression: "1570 .. 1572" }), { name: "A", city: null });
    expect(m[0]).toEqual({ label: { en: ["Date"], es: ["Fecha"] }, value: { es: ["1570 .. 1572"] } });
  });
});

describe("manifest inputs from the tenant and repository", () => {
  it("gives a tenant with no settings no homepage, no provider and no METS link", () => {
    const m = resolveManifestInputs(BASE, "co-x-001", description(), repository(), EMPTY_TENANT, null);
    expect("homepage" in m).toBe(false);
    expect(m.provider).toEqual([]);
    expect("see_also" in m).toBe(false);
    expect(m.id).toBe(`${BASE}/iiif/co-x-001/manifest.json`);
  });

  it("leaves the provider's homepage out when the tenant has no public site name", () => {
    const m = resolveManifestInputs(BASE, "co-x-001", description(), repository(), {
      ...EMPTY_TENANT,
      publicSiteUrl: "https://site.example.test",
      providerName: "Provider",
      providerUrl: "https://provider.example.test/",
    }, null);
    expect(m.provider).toEqual([
      { id: "https://provider.example.test/", type: "Agent", label: { en: ["Provider"], es: ["Provider"] } },
    ]);
    expect(m.homepage).toEqual([
      { id: "https://site.example.test/co-x-001/", type: "Text", label: { es: ["Test title"] }, format: "text/html" },
    ]);
  });

  it("removes ? and # from the reference code in the METS link", () => {
    const m = resolveManifestInputs(BASE, "co-x-001", description({ referenceCode: "co-x-0?1#" }), repository(), {
      ...EMPTY_TENANT,
      metsBaseUrl: "https://files.example.test/mets/",
    }, null);
    expect((m.see_also as Array<{ id: string }>)[0].id).toBe("https://files.example.test/mets/co-x-01.xml");
  });

  it("carries the scope and content as the summary when set", () => {
    expect(resolveManifestInputs(BASE, "co-x-001", description({ scopeContent: "Nota" }), repository(), EMPTY_TENANT, null).summary).toEqual({
      es: ["Nota"],
    });
    expect("summary" in resolveManifestInputs(BASE, "co-x-001", description({ scopeContent: "" }), repository(), EMPTY_TENANT, null)).toBe(false);
  });

  const HOSTING = { hostingStatementEs: "Alojado en Zasqua (zasqua.org).", hostingStatementEn: "Hosted on Zasqua (zasqua.org)." };
  const statement = (en: string[] | null, es: string[] | null) => ({
    label: { ...(en ? { en: ["Attribution"] } : {}), ...(es ? { es: ["Atribución"] } : {}) },
    value: { ...(en ? { en } : {}), ...(es ? { es } : {}) },
  });

  it("carries the composed line, per language, when the repository has no override", () => {
    const repo = repository({
      city: "Tunja",
      region: "Boyacá",
      country: "Colombia",
      manifestRights: "http://creativecommons.org/licenses/by-nc/4.0/",
      creditStatementEs: "Digitalizado en alianza con Neogranadina.",
      creditStatementEn: "Digitized in partnership with Neogranadina.",
    });
    const m = resolveManifestInputs(BASE, "co-x-001", description(), repo, EMPTY_TENANT, HOSTING);
    expect(m.required_statement).toEqual(statement(
      ["Test repository, Tunja, Boyacá, Colombia. Digitized in partnership with Neogranadina. Hosted on Zasqua (zasqua.org). CC BY-NC 4.0."],
      ["Test repository, Tunja, Boyacá, Colombia. Digitalizado en alianza con Neogranadina. Alojado en Zasqua (zasqua.org). CC BY-NC 4.0."],
    ));
  });

  it("names the country in English in the English line, from the country code", () => {
    const repo = repository({ name: "Biblioteca Nacional del Perú", city: "Lima", country: "Perú", countryCode: "PER" });
    const m = resolveManifestInputs(BASE, "pe-x-001", description(), repo, EMPTY_TENANT, null);
    expect(m.required_statement).toEqual(statement(
      ["Biblioteca Nacional del Perú, Lima, Peru."],
      ["Biblioteca Nacional del Perú, Lima, Perú."],
    ));
  });

  it("carries the composed line without a hosting statement for a federation without one", () => {
    const m = resolveManifestInputs(BASE, "co-x-001", description(), repository(), EMPTY_TENANT, null);
    expect(m.required_statement).toEqual(statement(["Test repository."], ["Test repository."]));
  });

  it("uses an override in its own language and the composed line in the other", () => {
    const m = resolveManifestInputs(BASE, "co-x-001", description(), repository({ attributionEn: "Hand-written line." }), EMPTY_TENANT, HOSTING);
    expect(m.required_statement).toEqual(statement(
      ["Hand-written line."],
      ["Test repository. Alojado en Zasqua (zasqua.org)."],
    ));
  });

  it("writes only the languages that have a line, inventing none", () => {
    const bare = repository({ name: " " });
    expect(resolveManifestInputs(BASE, "co-x-001", description(), bare, EMPTY_TENANT, { hostingStatementEs: "Alojado en Zasqua.", hostingStatementEn: null }).required_statement)
      .toEqual(statement(null, ["Alojado en Zasqua."]));
    expect(resolveManifestInputs(BASE, "co-x-001", description(), repository({ name: "", attributionEn: "Only English" }), EMPTY_TENANT, null).required_statement)
      .toEqual(statement(["Only English"], null));
    expect(resolveManifestInputs(BASE, "co-x-001", description(), bare, EMPTY_TENANT, null).required_statement).toBeNull();
  });

  it("builds the statement through the resolver with the federation's hosting statement", () => {
    const resolve = manifestResolver(BASE, HOSTING);
    const m = resolve({ id: "pv", referenceCode: "co-v-001" } as any, description() as any, repository() as any, EMPTY_TENANT as any);
    expect(m.required_statement).toEqual(statement(
      ["Test repository. Hosted on Zasqua (zasqua.org)."],
      ["Test repository. Alojado en Zasqua (zasqua.org)."],
    ));
  });

  function refusal(fn: () => unknown): ManifestInputsError {
    try {
      fn();
    } catch (err) {
      if (err instanceof ManifestInputsError) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  }

  it("refuses a repository without rights, naming it", () => {
    for (const manifestRights of [null, ""]) {
      const err = refusal(() =>
        resolveManifestInputs(BASE, "co-x-001", description(), repository({ manifestRights }), EMPTY_TENANT, null),
      );
      expect(err.code).toBe("repository_rights_unset");
      expect(err.detail).toEqual({ repository_id: "repo-1", repository_code: "co-x" });
    }
  });

  it("refuses a volume with no description or repository as unavailable", () => {
    const resolve = manifestResolver(BASE, null);
    const volume = { id: "pv", referenceCode: "co-x-001" } as any;
    expect(refusal(() => resolve(volume, null, repository() as any, EMPTY_TENANT as any)).code).toBe(
      "manifest_inputs_unavailable",
    );
    expect(refusal(() => resolve(volume, description() as any, null, EMPTY_TENANT as any)).code).toBe(
      "manifest_inputs_unavailable",
    );
  });

  it("builds the id from the volume's reference code", () => {
    const resolve = manifestResolver(BASE, null);
    const m = resolve({ id: "pv", referenceCode: "co-v-001" } as any, description() as any, repository() as any, EMPTY_TENANT as any);
    expect(m.id).toBe(`${BASE}/iiif/co-v-001/manifest.json`);
  });
});

describe("manifest locator", () => {
  it("maps the resolver's id to the key promotion writes", () => {
    for (const base of [BASE, "https://pub.example.test"]) {
      const m = resolveManifestInputs(base, "co-ahrb-aht-008", description({ referenceCode: "co-ahrb-aht-008" }), repository(), EMPTY_TENANT, null);
      expect(prefixLocator(base)(m.id, "co-ahrb-aht-008")).toBe("iiif/co-ahrb-aht-008/manifest.json");
    }
  });
});

// @version v0.9.0
