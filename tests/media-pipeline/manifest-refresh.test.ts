/**
 * Tests — the manifest attribution refresh, the text
 *
 * This suite pins the functions that rewrite three top-level fields of
 * a published manifest (`requiredStatement`, `provider`, `rights`) and
 * leave every other byte alone:
 *
 *   - a published manifest (the production manifest of one description,
 *     cut to two canvases, in `tests/fixtures/manifest-refresh/`) given
 *     its own three values comes back byte for byte;
 *   - given new values, only the three value spans change, written in
 *     the manifest's own separators and with non-ASCII characters raw;
 *   - a field the manifest lacks goes after the nearest field before it
 *     in the held-manifest order, a null value removes the field with
 *     one separator, and a compact or ASCII-escaped text keeps its style;
 *   - multi-line text, a duplicated key and a non-object are refused;
 *   - the comparison ignores key order and treats a null value as
 *     "absent";
 *   - the pre-write check catches any other field that changed or moved;
 *   - the key of a manifest URL is accepted only under the manifest
 *     address and under `iiif/`, with a reference segment of a closed
 *     character set: a tab, a percent escape, a backslash, a NUL, a
 *     non-ASCII dot, `.` and `..` are refused.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import published from "../fixtures/manifest-refresh/co-ahjci-mfc-001-001.json?raw";
import {
  ManifestSpliceError,
  checkSplice,
  currentValuesOf,
  differingFields,
  manifestKeyOf,
  refreshValuesOf,
  spliceRefreshFields,
  type RefreshValues,
} from "../../app/lib/pipeline/manifest-refresh";
import { resolveManifestInputs } from "../../app/lib/pipeline/manifest-inputs";

const TEXT = published as unknown as string;

const NEW_STATEMENT = {
  label: { en: ["Attribution"], es: ["Atribución"] },
  value: { en: ["Line in English."], es: ["Línea en español."] },
};
const NEW_STATEMENT_TEXT =
  '{"label": {"en": ["Attribution"], "es": ["Atribución"]}, "value": {"en": ["Line in English."], "es": ["Línea en español."]}}';

const NEW_PROVIDER = [{ id: "https://provider.example/", type: "Agent", label: { en: ["P"], es: ["P"] } }];
const NEW_PROVIDER_TEXT = '[{"id": "https://provider.example/", "type": "Agent", "label": {"en": ["P"], "es": ["P"]}}]';

function span(text: string, startMarker: string, endMarker: string): [number, number] {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`markers not found: ${startMarker} ${endMarker}`);
  return [start + startMarker.length, end];
}

describe("splicing a published manifest", () => {
  it("returns the same bytes when the three values are the manifest's own", () => {
    const doc = JSON.parse(TEXT);
    const values = currentValuesOf(doc);
    expect(differingFields(doc, values)).toEqual([]);
    expect(spliceRefreshFields(TEXT, values)).toBe(TEXT);
  });

  it("replaces only the three value spans, in the manifest's style", () => {
    const doc = JSON.parse(TEXT);
    const values: RefreshValues = {
      requiredStatement: NEW_STATEMENT,
      provider: NEW_PROVIDER,
      rights: "https://creativecommons.org/licenses/by/4.0/",
    };
    const after = spliceRefreshFields(TEXT, values);

    const [rsStart, rsEnd] = span(TEXT, '"requiredStatement": ', ', "rights": ');
    const [rStart, rEnd] = span(TEXT, '"rights": ', ', "provider": ');
    const [pStart, pEnd] = span(TEXT, '"provider": ', ', "seeAlso": ');
    const expected =
      TEXT.slice(0, rsStart) +
      NEW_STATEMENT_TEXT +
      TEXT.slice(rsEnd, rStart) +
      '"https://creativecommons.org/licenses/by/4.0/"' +
      TEXT.slice(rEnd, pStart) +
      NEW_PROVIDER_TEXT +
      TEXT.slice(pEnd);
    expect(after).toBe(expected);
    expect(differingFields(doc, values)).toEqual(["provider", "rights", "requiredStatement"]);
    expect(checkSplice(TEXT, after, values)).toBeNull();
  });

  it("writes the values resolveManifestInputs builds", () => {
    const inputs = resolveManifestInputs(
      "https://manifests.example",
      "co-x-001",
      {
        referenceCode: "co-x-001",
        title: "T",
        dateExpression: null,
        extent: null,
        language: null,
        accessConditions: null,
        scopeContent: null,
      },
      {
        id: "r1",
        code: "co-x",
        name: "Archivo X",
        city: "Ciudad",
        region: null,
        country: "Colombia",
        countryCode: "CO",
        manifestRights: "http://creativecommons.org/licenses/by-nc/4.0/",
        creditStatementEs: "Crédito.",
        creditStatementEn: "Credit.",
        attributionEn: null,
        attributionEs: null,
      },
      {
        publicSiteUrl: "https://site.example",
        publicSiteName: "Site",
        providerName: "Provider",
        providerUrl: "https://provider.example/",
        metsBaseUrl: null,
      },
      { hostingStatementEs: "Alojado aquí.", hostingStatementEn: "Hosted here." },
    );
    const values = refreshValuesOf(inputs);
    const after = spliceRefreshFields(TEXT, values);
    const doc = JSON.parse(after);
    expect(doc.requiredStatement).toEqual({
      label: { en: ["Attribution"], es: ["Atribución"] },
      value: {
        en: ["Archivo X, Ciudad, Colombia. Credit. Hosted here. CC BY-NC 4.0."],
        es: ["Archivo X, Ciudad, Colombia. Crédito. Alojado aquí. CC BY-NC 4.0."],
      },
    });
    expect(doc.provider[0].homepage[0].id).toBe("https://site.example/");
    expect(checkSplice(TEXT, after, values)).toBeNull();
    expect(Object.keys(doc)).toEqual(Object.keys(JSON.parse(TEXT)));
  });
});

describe("inserting and removing fields", () => {
  const HELD =
    '{"@context": "c", "id": "i", "type": "Manifest", "label": {"es": ["L"]}, "behavior": ["paged"], "items": []}';

  it("inserts absent fields after the nearest field before them in the held order", () => {
    const values: RefreshValues = { provider: [], rights: "r", requiredStatement: NEW_STATEMENT };
    expect(spliceRefreshFields(HELD, values)).toBe(
      '{"@context": "c", "id": "i", "type": "Manifest", "label": {"es": ["L"]}, "behavior": ["paged"], ' +
        '"provider": [], "items": [], "rights": "r", "requiredStatement": ' +
        NEW_STATEMENT_TEXT +
        "}",
    );
  });

  it("inserts a missing required statement after rights in a manifest of another order", () => {
    const text = '{"id": "i", "rights": "r", "provider": [], "items": []}';
    const values: RefreshValues = { provider: [], rights: "r", requiredStatement: { a: ["b"] } };
    expect(spliceRefreshFields(text, values)).toBe(
      '{"id": "i", "rights": "r", "requiredStatement": {"a": ["b"]}, "provider": [], "items": []}',
    );
  });

  it("inserts first when no earlier field is present", () => {
    const text = '{"items": []}';
    const values: RefreshValues = { provider: ["p"], rights: null, requiredStatement: null };
    expect(spliceRefreshFields(text, values)).toBe('{"provider": ["p"], "items": []}');
  });

  it("removes a field whose value is null, with one separator", () => {
    const values = (rs: null): RefreshValues => ({ provider: [], rights: "r", requiredStatement: rs });
    expect(
      spliceRefreshFields('{"id": "i", "requiredStatement": {"x": 1}, "rights": "r", "provider": []}', values(null)),
    ).toBe('{"id": "i", "rights": "r", "provider": []}');
    expect(spliceRefreshFields('{"requiredStatement": 1, "rights": "r", "provider": []}', values(null))).toBe(
      '{"rights": "r", "provider": []}',
    );
    expect(spliceRefreshFields('{"rights": "r", "provider": [], "requiredStatement": 1}', values(null))).toBe(
      '{"rights": "r", "provider": []}',
    );
  });

  it("keeps a compact style", () => {
    const text = '{"id":"i","rights":"old","provider":[]}';
    const values: RefreshValues = { provider: [{ a: 1 }], rights: "new", requiredStatement: { k: ["v"] } };
    expect(spliceRefreshFields(text, values)).toBe(
      '{"id":"i","rights":"new","requiredStatement":{"k":["v"]},"provider":[{"a":1}]}',
    );
  });

  it("escapes non-ASCII characters where the text escapes them", () => {
    const text = '{"label": {"es": ["Atribuci\\u00f3n"]}, "rights": "r", "provider": []}';
    const values: RefreshValues = { provider: [], rights: "r", requiredStatement: { es: ["Línea"] } };
    expect(spliceRefreshFields(text, values)).toBe(
      '{"label": {"es": ["Atribuci\\u00f3n"]}, "rights": "r", "requiredStatement": {"es": ["L\\u00ednea"]}, "provider": []}',
    );
  });
});

describe("text that is not rewritten", () => {
  const values: RefreshValues = { provider: [], rights: "r", requiredStatement: null };

  it("refuses a top level over several lines", () => {
    const text = JSON.stringify({ id: "i", rights: "x", provider: [] }, null, 2);
    expect(() => spliceRefreshFields(text, values)).toThrow(ManifestSpliceError);
    try {
      spliceRefreshFields(text, values);
    } catch (err) {
      expect((err as ManifestSpliceError).code).toBe("format_unsupported");
    }
  });

  it("refuses a key named twice", () => {
    try {
      spliceRefreshFields('{"rights": "a", "rights": "b", "provider": []}', values);
      expect.unreachable();
    } catch (err) {
      expect((err as ManifestSpliceError).code).toBe("duplicate_key");
    }
  });

  it("refuses text that is not an object", () => {
    try {
      spliceRefreshFields("[1, 2]", values);
      expect.unreachable();
    } catch (err) {
      expect((err as ManifestSpliceError).code).toBe("not_json_object");
    }
  });
});

describe("comparing and checking", () => {
  it("ignores key order and reads a null value as absent", () => {
    const doc = {
      rights: "r",
      provider: [{ type: "Agent", id: "p" }],
      requiredStatement: { value: { es: ["x"] }, label: { es: ["y"] } },
    };
    expect(
      differingFields(doc, {
        rights: "r",
        provider: [{ id: "p", type: "Agent" }],
        requiredStatement: { label: { es: ["y"] }, value: { es: ["x"] } },
      }),
    ).toEqual([]);
    expect(differingFields(doc, { rights: "r", provider: doc.provider, requiredStatement: null })).toEqual([
      "requiredStatement",
    ]);
    expect(differingFields({ provider: [] }, { rights: null, provider: [], requiredStatement: null })).toEqual([]);
  });

  it("names another field that changed or moved", () => {
    const values: RefreshValues = { provider: [], rights: "r", requiredStatement: null };
    const before = '{"id": "i", "label": "a", "rights": "r", "provider": []}';
    expect(checkSplice(before, '{"id": "i", "label": "b", "rights": "r", "provider": []}', values)).toBe("$.label");
    expect(checkSplice(before, '{"label": "a", "id": "i", "rights": "r", "provider": []}', values)).toBe("key_order");
    expect(checkSplice(before, '{"id": "i", "label": "a", "rights": "x", "provider": []}', values)).toBe("$.rights");
    expect(checkSplice(before, before, values)).toBeNull();
  });
});

describe("the object key of a manifest URL", () => {
  const BASE = "https://manifests.example/";

  it("accepts only reference segments of letters, digits, '-', '_', '.' and '~'", () => {
    const ref = (segment: string) => manifestKeyOf(`https://manifests.example/iiif/${segment}/manifest.json`, BASE, "t");
    expect(ref("co-A_1.v~2")).toEqual({ key: "iiif/co-A_1.v~2/manifest.json" });
    for (const segment of [
      ".\t.",
      "a\tb",
      "%2e%2e",
      "a\\b",
      "a\u0000b",
      "\u2024\u2024",
      "a\u00e9",
      ".",
      "..",
      "a b",
      "a?b",
      "a#b",
      "",
    ]) {
      expect(ref(segment), JSON.stringify(segment)).toEqual({ refusal: "key_not_allowed" });
    }
    // A key under a tenant slug outside the set is refused the same way.
    expect(manifestKeyOf("https://manifests.example/t\u0000/iiif/a/manifest.json", BASE, "t\u0000")).toEqual({
      refusal: "key_not_allowed",
    });
  });


  it("accepts a key under iiif/, at the root or under the tenant's slug", () => {
    expect(manifestKeyOf("https://manifests.example/iiif/co-a-1/manifest.json", BASE, "t")).toEqual({
      key: "iiif/co-a-1/manifest.json",
    });
    expect(manifestKeyOf("https://manifests.example/t/iiif/co-a-1/manifest.json", BASE, "t")).toEqual({
      key: "t/iiif/co-a-1/manifest.json",
    });
  });

  it("refuses a URL outside the address, outside iiif/, or with a key that is not allowed", () => {
    expect(manifestKeyOf("https://other.example/iiif/a/manifest.json", BASE, "t")).toEqual({
      refusal: "outside_manifest_base",
    });
    expect(manifestKeyOf("https://manifests.example/mets/a.xml", BASE, "t")).toEqual({ refusal: "key_outside_iiif" });
    expect(manifestKeyOf("https://manifests.example/u/iiif/a/manifest.json", BASE, "t")).toEqual({
      refusal: "key_outside_iiif",
    });
    expect(manifestKeyOf("https://manifests.example/iiif/../x/manifest.json", BASE, "t")).toEqual({
      refusal: "key_not_allowed",
    });
    expect(manifestKeyOf("https://manifests.example/iiif/a%2Fb/manifest.json", BASE, "t")).toEqual({
      refusal: "key_not_allowed",
    });
  });
});
