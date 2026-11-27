/**
 * Tests — manifest settings seed
 *
 * This suite pins the plan the manifest-fields command makes for the
 * two seeded tenants (Neogranadina and ahr) and their repositories: the attribution comes from
 * the generator's template for the repository's code, filled with the
 * name, city and country as stored (Perú written Peru in English); a
 * repository with no template is left out; a field already holding the
 * planned value is unchanged, an empty one is written, and one holding
 * another value is kept; the statements write only the fields to write,
 * scoped to the row and to its own tenant id; and a tenant that is not
 * seeded is refused.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import {
  planManifestFields,
  planStatements,
  type RepositoryRow,
  type TenantRow,
} from "../../scripts/commands/manifest-fields";
import { AHR_TENANT_ID, NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";

const TENANT: TenantRow = {
  id: NEOGRANADINA_TENANT_ID,
  slug: "neogranadina",
  public_site_url: null,
  public_site_name: null,
  provider_name: null,
  provider_url: null,
  mets_base_url: null,
};

const AHR_TENANT: TenantRow = { ...TENANT, id: AHR_TENANT_ID, slug: "ahr" };

function repo(over: Partial<RepositoryRow>): RepositoryRow {
  return {
    id: "r",
    code: "co-x",
    name: "Name",
    city: null,
    country: null,
    manifest_rights: null,
    attribution_en: null,
    attribution_es: null,
    rights_text: null,
    ...over,
  };
}

const BN = repo({ id: "r-bn", code: "pe-bn", name: "Biblioteca Nacional del Perú", city: "Lima", country: "Perú" });
const AHRB = repo({ id: "r-ahrb", code: "co-ahrb", name: "Archivo Histórico Regional de Boyacá", city: "Tunja", country: "Colombia" });

describe("manifest settings plan", () => {
  it("plans the tenant values and each repository's attribution from its template", () => {
    const plans = planManifestFields(TENANT, [BN, AHRB, repo({ id: "r-o", code: "us-other" })]);
    expect(plans.map((p) => p.label)).toEqual(["tenant neogranadina", "repository co-ahrb", "repository pe-bn"]);
    expect(Object.fromEntries(plans[0].fields.map((f) => [f.column, f.planned]))).toEqual({
      public_site_url: "https://zasqua.org",
      public_site_name: "Zasqua",
      provider_name: "Neogranadina",
      provider_url: "https://neogranadina.org/",
      mets_base_url: "https://manifests.zasqua.org/mets",
    });
    expect(Object.fromEntries(plans[2].fields.map((f) => [f.column, f.planned]))).toEqual({
      manifest_rights: "http://creativecommons.org/licenses/by-nc/4.0/",
      attribution_en:
        "Biblioteca Nacional del Perú, Lima, Peru. Processed by Neogranadina and hosted on Zasqua (zasqua.org).",
      attribution_es:
        "Biblioteca Nacional del Perú, Lima, Perú. Procesado por Neogranadina y alojado en Zasqua (zasqua.org).",
      rights_text:
        "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase a la Biblioteca Nacional del Perú.",
    });
    for (const p of plans) for (const f of p.fields) expect(f.action).toBe("write");
  });

  it("leaves out the city when the repository has none", () => {
    const [, plan] = planManifestFields(TENANT, [{ ...AHRB, city: null }]);
    expect(plan.fields[1].planned).toBe(
      "Archivo Histórico Regional de Boyacá, Colombia. Digitized by Neogranadina and hosted on Zasqua (zasqua.org).",
    );
  });

  it("marks a field holding the planned value unchanged and one holding another value kept", () => {
    const [tenant, repository] = planManifestFields(
      { ...TENANT, public_site_name: "Zasqua", provider_name: "Another provider" },
      [{ ...AHRB, manifest_rights: "https://rights.example.test/" }],
    );
    const action = (p: typeof tenant, c: string) => p.fields.find((f) => f.column === c)!.action;
    expect(action(tenant, "public_site_name")).toBe("unchanged");
    expect(action(tenant, "provider_name")).toBe("kept");
    expect(action(tenant, "public_site_url")).toBe("write");
    expect(action(repository, "manifest_rights")).toBe("kept");
  });

  it("writes only the fields to write, scoped to each row", () => {
    const plans = planManifestFields({ ...TENANT, public_site_name: "Zasqua", provider_name: "Other" }, [
      {
        ...AHRB,
        manifest_rights: "http://creativecommons.org/licenses/by-nc/4.0/",
        attribution_en: "x",
        attribution_es: "y",
        rights_text: "z",
      },
      BN,
    ]);
    const sql = planStatements(plans, 1000);
    expect(sql).toHaveLength(2);
    expect(sql[0]).toBe(
      "UPDATE tenants SET public_site_url = 'https://zasqua.org', provider_url = 'https://neogranadina.org/', " +
        `mets_base_url = 'https://manifests.zasqua.org/mets', updated_at = 1000 WHERE id = '${NEOGRANADINA_TENANT_ID}';`,
    );
    expect(sql[1]).toMatch(/^UPDATE repositories SET manifest_rights = .*, attribution_en = .*, attribution_es = .*, rights_text = .*, updated_at = 1000 WHERE tenant_id = '.*' AND id = 'r-bn';$/);
  });

  it("plans the ahr tenant with the same five values as Neogranadina", () => {
    expect(AHR_TENANT_ID).toBe("c82525bd-13d5-46dd-9c1b-e258507b966c");
    const [plan] = planManifestFields(AHR_TENANT, []);
    expect(plan.label).toBe("tenant ahr");
    expect(Object.fromEntries(plan.fields.map((f) => [f.column, f.planned]))).toEqual({
      public_site_url: "https://zasqua.org",
      public_site_name: "Zasqua",
      provider_name: "Neogranadina",
      provider_url: "https://neogranadina.org/",
      mets_base_url: "https://manifests.zasqua.org/mets",
    });
  });

  it("fills the co-ahr attribution in both languages", () => {
    const ahr = repo({ id: "r-ahr", code: "co-ahr", name: "Archivo Histórico de Rionegro", city: "Rionegro", country: "Colombia" });
    const [, plan] = planManifestFields(AHR_TENANT, [ahr]);
    expect(plan.label).toBe("repository co-ahr");
    expect(Object.fromEntries(plan.fields.map((f) => [f.column, f.planned]))).toEqual({
      manifest_rights: "http://creativecommons.org/licenses/by-nc/4.0/",
      attribution_en:
        "Archivo Histórico de Rionegro, Rionegro, Colombia. Digitized with Neogranadina and hosted on Zasqua (zasqua.org).",
      attribution_es:
        "Archivo Histórico de Rionegro, Rionegro, Colombia. Digitalizado con Neogranadina y alojado en Zasqua (zasqua.org).",
      rights_text:
        "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al Archivo Histórico de Rionegro.",
    });
  });

  it("scopes each write to its own tenant id", () => {
    const ahr = repo({ id: "r-ahr", code: "co-ahr", name: "Archivo Histórico de Rionegro", city: "Rionegro", country: "Colombia" });
    const sql = planStatements([...planManifestFields(TENANT, [BN]), ...planManifestFields(AHR_TENANT, [ahr])], 1000);
    expect(sql).toHaveLength(4);
    expect(sql[0]).toContain(`WHERE id = '${NEOGRANADINA_TENANT_ID}';`);
    expect(sql[1]).toContain(`WHERE tenant_id = '${NEOGRANADINA_TENANT_ID}' AND id = 'r-bn';`);
    expect(sql[2]).toContain(`WHERE id = '${AHR_TENANT_ID}';`);
    expect(sql[3]).toContain(`WHERE tenant_id = '${AHR_TENANT_ID}' AND id = 'r-ahr';`);
    expect(sql.slice(0, 2).join("")).not.toContain(AHR_TENANT_ID);
    expect(sql.slice(2).join("")).not.toContain(NEOGRANADINA_TENANT_ID);
  });

  it("keeps a rights_text set on the form and writes an empty one", () => {
    const plans = planManifestFields(TENANT, [{ ...BN, rights_text: "Set on the form." }, AHRB]);
    const field = (label: string) =>
      plans.find((p) => p.label === label)!.fields.find((f) => f.column === "rights_text")!;
    expect(field("repository pe-bn")).toMatchObject({ action: "kept", current: "Set on the form." });
    expect(field("repository co-ahrb")).toMatchObject({
      action: "write",
      planned:
        "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al Archivo Histórico Regional de Boyacá.",
    });
  });

  it("refuses a tenant that is not seeded", () => {
    expect(() => planManifestFields({ ...TENANT, id: "other", slug: "other" }, [])).toThrow(/are seeded, not other/);
  });
});

// @version v0.8.0
