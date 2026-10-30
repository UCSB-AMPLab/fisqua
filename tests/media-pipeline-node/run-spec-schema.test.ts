/**
 * Tests — media pipeline run spec: JSON Schema and Zod agreement
 *
 * The run spec has two validators. The committed JSON Schema
 * (`app/lib/pipeline/run-spec.schema.json`) is the contract the runner
 * vendors and validates against; inside the Worker, Fisqua validates
 * with `runSpecSchema`, a Zod schema written to mirror it, because a JSON
 * Schema engine compiles validators with `new Function`, which the
 * Workers runtime forbids. This suite checks, in the Node pool, that the
 * two give every fixture the same verdict:
 *
 *   - the valid fixtures pass both;
 *   - the cross-field fixtures (`spec-invalid-cross-*`) pass both, since
 *     what they break is checked by `checkRunSpecInvariants`, which
 *     neither schema expresses and which this suite does not call;
 *   - every other invalid fixture fails both;
 *   - the valid fixture with the manifest block's optional fields added,
 *     removed or malformed gets the same verdict from both;
 *   - a page digest, well formed, malformed, or on an item-PDF page, gets
 *     the same verdict from both;
 *   - a page's quarter-turns, 1 to 3 on a volume run's page, any other
 *     value, or any value on an item-PDF page or a review run's page,
 *     gets the same verdict from both;
 *   - a page's `rotate_deg`, 0, 90, 180 or 270 on a volume run's or a
 *     review run's page (beside `quarter_turns` too), any other value,
 *     or any value on an item-PDF page, gets the same verdict from both;
 *   - a spec carrying the recipe each configured preset resolves to
 *     passes both;
 *   - the review fixtures (a review run, a purge run and a volume run
 *     that purges review prefixes) pass both, and each change to the
 *     bucket and endpoint rules a spec with review fields must meet gets
 *     the same verdict from both.
 *
 * Ajv runs in draft 2020-12 mode with `ajv-formats`, so `date-time`
 * strings are checked as the Zod schema checks them. Strict mode is on,
 * so a keyword Ajv does not know fails the suite rather than being
 * ignored. Its `strictTypes` lint is off: the schema's conditional
 * branches (`if: { properties: ... }`) name properties without restating
 * `type: "object"`, which is valid draft 2020-12, and the committed
 * schema's bytes are pinned, so it is not rewritten to suit the lint.
 * Its `strictRequired` lint is off for the same reason: the review
 * branches (`if: { required: ["review"] }`) require a property that the
 * branch itself does not define, which is also valid draft 2020-12.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { runSpecSchema } from "../../app/lib/pipeline/run-spec";
import { resolveRecipe } from "../../app/lib/pipeline/recipe";
import { RUN_PRESETS } from "../../app/lib/pipeline/run-config";

const schemaPath = fileURLToPath(
  new URL("../../app/lib/pipeline/run-spec.schema.json", import.meta.url),
);
const fixtureDir = fileURLToPath(new URL("../fixtures/media-pipeline/", import.meta.url));

const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

const specFixtures = readdirSync(fixtureDir)
  .filter((f) => /^spec-.*\.json$/.test(f))
  .sort()
  .map((f) => ({
    name: f.replace(/\.json$/, ""),
    doc: JSON.parse(readFileSync(join(fixtureDir, f), "utf8")) as unknown,
  }));

function expectedVerdict(name: string): boolean {
  return name.startsWith("spec-valid") || name.startsWith("spec-invalid-cross-");
}

describe("run spec JSON Schema and Zod schema agree", () => {
  it("finds the fixtures", () => {
    expect(specFixtures.filter((f) => f.name.startsWith("spec-valid")).length).toBe(8);
    expect(specFixtures.filter((f) => f.name.startsWith("spec-invalid-cross-")).length).toBe(13);
    expect(specFixtures.length).toBeGreaterThan(13);
  });

  it.each(specFixtures.map((f) => [f.name, f.doc] as const))(
    "%s gets the same verdict from both",
    (name, doc) => {
      const bySchema = validate(doc) as boolean;
      const byZod = runSpecSchema.safeParse(doc).success;
      const expected = expectedVerdict(name);
      expect(
        { schema: bySchema, zod: byZod },
        bySchema === expected ? undefined : JSON.stringify(validate.errors),
      ).toEqual({ schema: expected, zod: expected });
    },
  );
});

describe("optional manifest fields get the same verdict from both", () => {
  const base = specFixtures.find((f) => f.name === "spec-valid")!.doc as Record<string, any>;

  function variant(change: (manifest: Record<string, unknown>) => void): unknown {
    const doc = structuredClone(base);
    change(doc.volumes[0].manifest);
    return doc;
  }

  const metadata = [{ label: { en: ["Date"], es: ["Fecha"] }, value: { es: ["1570"] } }];
  const cases: Array<[string, (m: Record<string, unknown>) => void, boolean]> = [
    ["with metadata", (m) => { m.metadata = metadata; }, true],
    ["with an empty metadata list", (m) => { m.metadata = []; }, true],
    ["with a summary", (m) => { m.summary = { es: ["Resumen"] }; }, true],
    ["with see_also", (m) => { m.see_also = [{ id: "https://files.test/mets/x.xml", type: "Dataset" }]; }, true],
    ["without a homepage", (m) => { delete m.homepage; }, true],
    ["with an empty homepage list", (m) => { m.homepage = []; }, false],
    ["with a metadata entry without a value", (m) => { m.metadata = [{ label: { en: ["Date"] } }]; }, false],
    ["with a metadata entry carrying another key", (m) => { m.metadata = [{ ...metadata[0], extra: 1 }]; }, false],
    ["with a metadata label that is a string", (m) => { m.metadata = [{ label: "Date", value: { es: ["x"] } }]; }, false],
    ["with a summary that is a list", (m) => { m.summary = ["Resumen"]; }, false],
    ["with see_also that is an object", (m) => { m.see_also = { id: "x" }; }, false],
    ["with the manifest spelling seeAlso", (m) => { m.seeAlso = []; }, false],
  ];

  it.each(cases)("a spec %s", (_name, change, expected) => {
    const doc = variant(change);
    const bySchema = validate(doc) as boolean;
    const byZod = runSpecSchema.safeParse(doc).success;
    expect({ schema: bySchema, zod: byZod }).toEqual({ schema: expected, zod: expected });
  });
});

describe("page digests get the same verdict from both", () => {
  const DIGEST = "0123456789abcdef".repeat(4);
  const volumeRun = specFixtures.find((f) => f.name === "spec-valid-small")!.doc as Record<string, any>;
  const itemPdf = specFixtures.find((f) => f.name === "spec-valid-item-pdf")!.doc as Record<string, any>;

  function withDigest(base: Record<string, any>, digest: unknown): unknown {
    const doc = structuredClone(base);
    doc.volumes[0].pages[0].sha256 = digest;
    return doc;
  }

  const cases: Array<[string, unknown, boolean]> = [
    ["a volume-run page with a digest", withDigest(volumeRun, DIGEST), true],
    ["a digest in upper case", withDigest(volumeRun, DIGEST.toUpperCase()), false],
    ["a digest of 63 characters", withDigest(volumeRun, DIGEST.slice(1)), false],
    ["a digest of 65 characters", withDigest(volumeRun, `${DIGEST}0`), false],
    ["a digest with a character outside hex", withDigest(volumeRun, `g${DIGEST.slice(1)}`), false],
    ["a null digest", withDigest(volumeRun, null), false],
    ["a digest on an item-PDF page", withDigest(itemPdf, DIGEST), false],
  ];

  it.each(cases)("%s", (_name, doc, expected) => {
    const bySchema = validate(doc) as boolean;
    const byZod = runSpecSchema.safeParse(doc).success;
    expect({ schema: bySchema, zod: byZod }).toEqual({ schema: expected, zod: expected });
  });
});

describe("quarter turns get the same verdict from both", () => {
  const volumeRun = specFixtures.find((f) => f.name === "spec-valid-small")!.doc as Record<string, any>;
  const itemPdf = specFixtures.find((f) => f.name === "spec-valid-item-pdf")!.doc as Record<string, any>;
  const reviewRun = specFixtures.find((f) => f.name === "spec-valid-review-run")!.doc as Record<string, any>;

  function withTurns(base: Record<string, any>, turns: unknown): unknown {
    const doc = structuredClone(base);
    doc.volumes[0].pages[0].quarter_turns = turns;
    return doc;
  }

  const cases: Array<[string, unknown, boolean]> = [
    ["one turn on a volume-run page", withTurns(volumeRun, 1), true],
    ["two turns on a volume-run page", withTurns(volumeRun, 2), true],
    ["three turns on a volume-run page", withTurns(volumeRun, 3), true],
    ["no turn written as 0", withTurns(volumeRun, 0), false],
    ["four turns", withTurns(volumeRun, 4), false],
    ["a negative turn", withTurns(volumeRun, -1), false],
    ["a turn as a string", withTurns(volumeRun, "1"), false],
    ["a fractional turn", withTurns(volumeRun, 1.5), false],
    ["a null turn", withTurns(volumeRun, null), false],
    ["a turn on an item-PDF page", withTurns(itemPdf, 1), false],
    ["a turn on a review run's page", withTurns(reviewRun, 1), false],
  ];

  it.each(cases)("%s", (_name, doc, expected) => {
    const bySchema = validate(doc) as boolean;
    const byZod = runSpecSchema.safeParse(doc).success;
    expect({ schema: bySchema, zod: byZod }).toEqual({ schema: expected, zod: expected });
  });
});

describe("rotate_deg gets the same verdict from both", () => {
  const volumeRun = specFixtures.find((f) => f.name === "spec-valid-small")!.doc as Record<string, any>;
  const itemPdf = specFixtures.find((f) => f.name === "spec-valid-item-pdf")!.doc as Record<string, any>;
  const reviewRun = specFixtures.find((f) => f.name === "spec-valid-review-run")!.doc as Record<string, any>;

  function withDegrees(base: Record<string, any>, degrees: unknown, turns?: number): unknown {
    const doc = structuredClone(base);
    doc.volumes[0].pages[0].rotate_deg = degrees;
    if (turns !== undefined) doc.volumes[0].pages[0].quarter_turns = turns;
    return doc;
  }

  const cases: Array<[string, unknown, boolean]> = [
    ...[0, 90, 180, 270].map((d): [string, unknown, boolean] => [`${d} on a volume-run page`, withDegrees(volumeRun, d), true]),
    ...[0, 90, 180, 270].map((d): [string, unknown, boolean] => [`${d} on a review run's page`, withDegrees(reviewRun, d), true]),
    ["90 beside quarter_turns on a volume-run page", withDegrees(volumeRun, 90, 3), true],
    ["45", withDegrees(volumeRun, 45), false],
    ["360", withDegrees(volumeRun, 360), false],
    ["-90", withDegrees(volumeRun, -90), false],
    ["a fraction", withDegrees(volumeRun, 90.5), false],
    ["a string", withDegrees(volumeRun, "90"), false],
    ["null", withDegrees(volumeRun, null), false],
    ["90 on an item-PDF page", withDegrees(itemPdf, 90), false],
    ["a string on a review run's page", withDegrees(reviewRun, "180"), false],
  ];

  it.each(cases)("%s", (_name, doc, expected) => {
    const bySchema = validate(doc) as boolean;
    const byZod = runSpecSchema.safeParse(doc).success;
    expect({ schema: bySchema, zod: byZod }, JSON.stringify(validate.errors)).toEqual({ schema: expected, zod: expected });
  });
});

describe("resolved recipes pass both schemas", () => {
  const base = specFixtures.find((f) => f.name === "spec-valid-volume-ocr")!.doc as Record<string, any>;

  const cases = [
    ["a tonal declaration", { outputClass: "tonal", ocr: false, ocrLang: null, tonePreset: "tonal-default" }],
    ["a bilevel declaration with OCR in Spanish", { outputClass: "bilevel", ocr: true, ocrLang: "spa", tonePreset: "bilevel-default" }],
    ["a bilevel declaration without OCR", { outputClass: "bilevel", ocr: false, ocrLang: null, tonePreset: "bilevel-default" }],
  ] as const;

  it.each(cases)("a spec carrying the recipe of %s", (_name, decl) => {
    const doc = structuredClone(base);
    const current = doc.volumes[0].recipe;
    doc.volumes[0].recipe = resolveRecipe(
      "volume_run",
      {
        id: current.declaration_id,
        version: current.declaration_version,
        platen: current.capture.platen,
        background: current.capture.background,
        advancedParams: "{}",
        ...decl,
      },
      RUN_PRESETS,
      [],
    );
    const bySchema = validate(doc) as boolean;
    const byZod = runSpecSchema.safeParse(doc).success;
    expect({ schema: bySchema, zod: byZod }, JSON.stringify(validate.errors)).toEqual({ schema: true, zod: true });
  });
});

describe("bucket and endpoint rules with review fields get the same verdict from both", () => {
  const purging = specFixtures.find((f) => f.name === "spec-valid-volume-review-purge")!.doc as Record<string, any>;
  const reviewRun = specFixtures.find((f) => f.name === "spec-valid-review-run")!.doc as Record<string, any>;
  const small = specFixtures.find((f) => f.name === "spec-valid-small")!.doc as Record<string, any>;
  const R2 = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com";

  function variant(base: Record<string, any>, change: (d: Record<string, any>) => void): unknown {
    const doc = structuredClone(base);
    change(doc);
    return doc;
  }

  const cases: Array<[string, unknown, boolean]> = [
    ["an R2 destination with its own host and bucket names", variant(purging, (d) => {
      d.destination = { ...d.destination, backend: "r2", endpoint: R2, tiles_bucket: "tiles-test", ocr_bucket: "tiles-test" };
    }), true],
    ["an R2 destination on its EU host", variant(purging, (d) => {
      d.destination = { ...d.destination, backend: "r2", endpoint: R2.replace(".r2.", ".eu.r2."), tiles_bucket: "tiles-test", ocr_bucket: "tiles-test" };
    }), true],
    ["an R2 destination on a B2 host", variant(purging, (d) => { d.destination.backend = "r2"; }), false],
    ["an R2 bucket name in upper case", variant(purging, (d) => {
      d.destination = { ...d.destination, backend: "r2", endpoint: R2, tiles_bucket: "Tiles-Test", ocr_bucket: "tiles-test" };
    }), false],
    ["a B2 host in upper case with a port and a slash", variant(purging, (d) => {
      d.working.endpoint = "HTTPS://S3.TEST-000.BACKBLAZEB2.COM:443/";
    }), true],
    ["a B2 host with a path", variant(purging, (d) => { d.working.endpoint = "https://s3.test-000.backblazeb2.com/x"; }), false],
    ["a B2 bucket of five characters", variant(purging, (d) => { d.review.bucket = "abcde"; }), false],
    ["a B2 bucket with a slash", variant(purging, (d) => { d.destination.tiles_bucket = "tiles/x"; }), false],
    ["an R2 source on a B2 host", variant(purging, (d) => { d.volumes[0].source.backend = "r2"; }), false],
    ["a review image address that is not https", variant(reviewRun, (d) => { d.review.image_base_url = "http://x.test"; }), false],
    ["a review block with an unknown key", variant(reviewRun, (d) => { d.review.region = "x"; }), false],
    ["a review volume carrying a recipe", variant(reviewRun, (d) => { d.volumes[0].recipe = {}; }), false],
    ["a review prefix with one segment", variant(reviewRun, (d) => { d.volumes[0].review_prefix = "test-tenant/"; }), false],
    ["a review prefix with a leading dot", variant(reviewRun, (d) => { d.volumes[0].review_prefix = ".t/d/"; }), false],
    ["a review run with a processing volume", variant(reviewRun, (d) => { d.volumes = structuredClone(small.volumes); }), false],
    ["a volume run with a review block and no purge", variant(purging, (d) => { delete d.volumes[0].review_purge; }), true],
    ["a volume run with an empty purge list", variant(purging, (d) => { d.volumes[0].review_purge = []; }), false],
    ["a spec without review fields on hosts the rules would refuse", structuredClone(small), true],
  ];

  it.each(cases)("%s", (_name, doc, expected) => {
    const bySchema = validate(doc) as boolean;
    const byZod = runSpecSchema.safeParse(doc).success;
    expect({ schema: bySchema, zod: byZod }, JSON.stringify(validate.errors)).toEqual({ schema: expected, zod: expected });
  });
});

// @version v0.8.0
