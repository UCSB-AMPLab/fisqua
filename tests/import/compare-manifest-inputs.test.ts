/**
 * Tests — manifest inputs comparison
 *
 * This suite pins how the read-only comparison script reports a built
 * manifest block against a published manifest: identical fields report
 * nothing; a changed field is named by its manifest key; a homepage that
 * differs only in its label is reported as `homepage.label`; metadata is
 * compared entry by entry; a changed Date, and a metadata entry or
 * summary the published manifest lacks, are marked expected, with the
 * reason, and any other difference is not; an unexpected top-level field
 * in the published manifest is reported; and the sample takes evenly
 * spaced items.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { compareManifest, evenSample } from "../../scripts/compare-manifest-inputs";

const date = (v: string) => ({ label: { en: ["Date"], es: ["Fecha"] }, value: { es: [v] } });
const language = (v: string) => ({ label: { en: ["Language"], es: ["Idioma"] }, value: { es: [v] } });
const ref = { label: { en: ["Reference"], es: ["Signatura"] }, value: { es: ["co-x-001"] } };
const home = (title: string) => [{ id: "https://site.test/co-x-001/", type: "Text", label: { es: [title] }, format: "text/html" }];

function built(over: Record<string, unknown> = {}) {
  return {
    id: "https://m.test/iiif/co-x-001/manifest.json",
    label: { es: ["Title"] },
    homepage: home("Title"),
    rights: "http://creativecommons.org/licenses/by-nc/4.0/",
    required_statement: null,
    provider: [],
    metadata: [date("1570"), ref],
    ...over,
  };
}

function published(over: Record<string, unknown> = {}) {
  return {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: "https://m.test/iiif/co-x-001/manifest.json",
    type: "Manifest",
    label: { es: ["Title"] },
    metadata: [date("1570"), ref],
    rights: "http://creativecommons.org/licenses/by-nc/4.0/",
    provider: [],
    homepage: home("Title"),
    behavior: ["paged"],
    ...over,
  };
}

describe("compareManifest", () => {
  it("reports nothing for identical fields", () => {
    expect(compareManifest(built(), published())).toEqual([]);
  });

  it("names a changed label, and a homepage differing only in its label", () => {
    const d = compareManifest(built(), published({ label: { es: ["Old"] }, homepage: home("Old") }));
    expect(d.map((x) => x.field)).toEqual(["label", "homepage.label"]);
  });

  it("names a homepage with another id as homepage", () => {
    const d = compareManifest(built(), published({ homepage: [{ ...home("Title")[0], id: "https://other.test/" }] }));
    expect(d.map((x) => x.field)).toEqual(["homepage"]);
  });

  it("marks a changed Date and added entries expected, and other metadata differences not", () => {
    const d = compareManifest(
      built({ metadata: [date("1570 .. 1572"), language("Español"), ref] }),
      published({ metadata: [date("1570-1572"), ref] }),
    );
    expect(d.map((x) => [x.field, x.expected, x.reason])).toEqual([
      ["metadata.Date", true, "stored date changed"],
      ["metadata.Language", true, "added since publication"],
    ]);
    const added = compareManifest(built(), published({ metadata: [ref] }));
    expect(added.map((x) => [x.field, x.expected, x.reason])).toEqual([
      ["metadata.Date", true, "added since publication"],
    ]);
    const changed = compareManifest(
      built({ metadata: [date("1570"), language("Latín"), ref] }),
      published({ metadata: [date("1570"), language("Español"), ref] }),
    );
    expect(changed.map((x) => [x.field, x.expected])).toEqual([["metadata.Language", false]]);
    const removed = compareManifest(built(), published({ metadata: [date("1570"), language("Español"), ref] }));
    expect(removed.map((x) => [x.field, x.expected])).toEqual([["metadata.Language", false]]);
  });

  it("marks a summary the published manifest lacks expected, and a changed one not", () => {
    const summary = { es: ["Scope"] };
    const added = compareManifest(built({ summary }), published());
    expect(added.map((x) => [x.field, x.expected, x.reason])).toEqual([
      ["summary", true, "added since publication"],
    ]);
    const changed = compareManifest(built({ summary }), published({ summary: { es: ["Old"] } }));
    expect(changed.map((x) => [x.field, x.expected])).toEqual([["summary", false]]);
  });

  it("reports metadata in another order once the entries agree", () => {
    const d = compareManifest(built(), published({ metadata: [ref, date("1570")] }));
    expect(d.map((x) => x.field)).toEqual(["metadata (order)"]);
  });

  it("reports a published field the pipeline does not build", () => {
    const d = compareManifest(built(), published({ rendering: [] }));
    expect(d.map((x) => x.field)).toEqual(["rendering"]);
  });
});

describe("evenSample", () => {
  it("takes evenly spaced items, or all of a short list", () => {
    expect(evenSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toEqual([2, 4, 6, 8, 10]);
    expect(evenSample([1, 2], 5)).toEqual([1, 2]);
  });
});

// @version v0.8.0
