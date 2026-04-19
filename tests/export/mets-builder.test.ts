/**
 * Tests — mets builder
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import {
  buildMetsXml,
  type MetsInput,
  type MetsRepository,
} from "../../app/lib/export/mets-builder";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<MetsInput> = {}): MetsInput {
  return {
    referenceCode: "co-ahr-gob",
    title: "Gobernación",
    descriptionLevel: "fonds",
    dateExpression: "1810-1850",
    scopeContent: "Documentos de la gobernación",
    creatorDisplay: "Gobernación de Rionegro",
    language: "192",
    extent: "50 cajas",
    placeDisplay: "Rionegro, Antioquia",
    imprint: null,
    parentReferenceCode: null,
    hasDigital: false,
    iiifManifestUrl: null,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<MetsRepository> = {}): MetsRepository {
  return {
    name: "Archivo Histórico de Rionegro",
    city: "Rionegro",
    code: "co-ahr",
    rightsText: null,
    ...overrides,
  };
}

const CREATE_DATE = "2026-01-15T10:00:00Z";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildMetsXml", () => {
  it("produces valid XML with correct root attributes for a fonds-level description", () => {
    const xml = buildMetsXml(makeInput(), makeRepo(), CREATE_DATE);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('OBJID="co-ahr-gob"');
    expect(xml).toContain('LABEL="Gobernación"');
    expect(xml).toContain('TYPE="fonds"');
    expect(xml).toContain("http://www.loc.gov/METS/");
    expect(xml).toContain('CREATEDATE="2026-01-15T10:00:00Z"');
    // Creator agent
    expect(xml).toContain(
      "Fundación Histórica Neogranadina (NIT 900.861.407), Bogotá, Colombia"
    );
    expect(xml).toContain("https://neogranadina.org");
    // Custodian agent
    expect(xml).toContain("Archivo Histórico de Rionegro");
  });

  it("includes fileSec with FLocat when iiifManifestUrl is provided", () => {
    const xml = buildMetsXml(
      makeInput({
        iiifManifestUrl: "https://iiif.zasqua.org/co-ahr-gob-caj001/manifest.json",
        hasDigital: true,
      }),
      makeRepo(),
      CREATE_DATE
    );

    expect(xml).toContain("<fileSec>");
    expect(xml).toContain('USE="IIIF manifest"');
    expect(xml).toContain('ID="iiif-manifest"');
    expect(xml).toContain('MIMETYPE="application/ld+json"');
    expect(xml).toContain(
      'href="https://iiif.zasqua.org/co-ahr-gob-caj001/manifest.json"'
    );
    expect(xml).toContain('FILEID="iiif-manifest"');
  });

  it("omits fileSec when iiifManifestUrl is null", () => {
    const xml = buildMetsXml(
      makeInput({ iiifManifestUrl: null }),
      makeRepo(),
      CREATE_DATE
    );

    expect(xml).not.toContain("<fileSec>");
    expect(xml).not.toContain("FLocat");
    expect(xml).not.toContain('FILEID="iiif-manifest"');
  });

  it("uses repository rightsText in dc:rights when hasDigital is true", () => {
    const xml = buildMetsXml(
      makeInput({ hasDigital: true }),
      makeRepo({
        rightsText:
          "CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al Archivo Histórico de Rionegro.",
      }),
      CREATE_DATE
    );

    expect(xml).toContain(
      "CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al Archivo Histórico de Rionegro."
    );
    expect(xml).not.toContain(
      "Los catálogos y descripciones de Zasqua son de libre acceso."
    );
  });

  it("uses default rights text when repository rightsText is null", () => {
    const xml = buildMetsXml(
      makeInput({ hasDigital: true }),
      makeRepo({ rightsText: null }),
      CREATE_DATE
    );

    expect(xml).toContain(
      "Los catálogos y descripciones de Zasqua son de libre acceso."
    );
  });

  it("escapes XML special characters in title and other fields", () => {
    const xml = buildMetsXml(
      makeInput({
        title: 'Escritura de venta & compra "notarial" <1810>',
        scopeContent: "Scope with <tags> & entities",
      }),
      makeRepo(),
      CREATE_DATE
    );

    expect(xml).toContain(
      'LABEL="Escritura de venta &amp; compra &quot;notarial&quot; &lt;1810&gt;"'
    );
    expect(xml).toContain(
      "Escritura de venta &amp; compra &quot;notarial&quot; &lt;1810&gt;"
    );
    expect(xml).toContain("Scope with &lt;tags&gt; &amp; entities");
  });

  it("includes dcterms:isPartOf when parentReferenceCode is provided", () => {
    const xml = buildMetsXml(
      makeInput({
        parentReferenceCode: "co-ahr-gob-caj001",
        descriptionLevel: "item",
      }),
      makeRepo(),
      CREATE_DATE
    );

    expect(xml).toContain("dcterms:isPartOf");
    expect(xml).toContain("co-ahr-gob-caj001");
  });

  it("includes dc:publisher when imprint is provided", () => {
    const xml = buildMetsXml(
      makeInput({ imprint: "Imprenta Real, Bogotá, 1815" }),
      makeRepo(),
      CREATE_DATE
    );

    expect(xml).toContain("dc:publisher");
    expect(xml).toContain("Imprenta Real, Bogotá, 1815");
  });

  it("maps description levels to correct DC types", () => {
    // fonds → Collection
    const fondXml = buildMetsXml(
      makeInput({ descriptionLevel: "fonds" }),
      makeRepo(),
      CREATE_DATE
    );
    expect(fondXml).toContain("<dc:type>Collection</dc:type>");

    // item → Text
    const itemXml = buildMetsXml(
      makeInput({ descriptionLevel: "item" }),
      makeRepo(),
      CREATE_DATE
    );
    expect(itemXml).toContain("<dc:type>Text</dc:type>");

    // volume → Text
    const volXml = buildMetsXml(
      makeInput({ descriptionLevel: "volume" }),
      makeRepo(),
      CREATE_DATE
    );
    expect(volXml).toContain("<dc:type>Text</dc:type>");
  });
});
