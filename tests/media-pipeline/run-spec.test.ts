/**
 * Tests — media pipeline run spec validator
 *
 * This suite pins the run spec Fisqua publishes to the media pipeline
 * runner: the Zod validator that mirrors the canonical JSON Schema, and
 * the cross-field checks the schema cannot express.
 *
 *   - the valid fixtures (a volume run with a full page list, an item
 *     PDF, and a bilevel volume run with OCR in Spanish) pass
 *     `validateRunSpec`, as does the compact volume run the invalid
 *     fixtures are derived from;
 *   - a volume run whose OCR stage runs must name a non-empty `lang`;
 *     an item PDF's OCR stage names none;
 *   - every invalid fixture is refused, and the error names the
 *     offending path and, for a cross-field fixture, the rule;
 *   - `checkVolumePages` finds exactly one problem in each page-level
 *     cross-field fixture, so the dispatcher can call it before any
 *     write and name the rule; the job-level fixtures are caught by
 *     `checkRunSpecInvariants`, with exactly one problem each;
 *   - a volume-run page may carry its master's SHA-256, 64 lowercase hex
 *     characters; any other form, and a digest on an item-PDF page, is
 *     refused;
 *   - a volume-run page may carry `quarter_turns` of 1, 2 or 3; 0, 4, a
 *     string, and a turn on an item-PDF page or a review run's page are
 *     refused;
 *   - a volume-run page and a review run's page may carry `rotate_deg`
 *     of 0, 90, 180 or 270, beside `quarter_turns`; any other value, and
 *     the field on an item-PDF page, are refused;
 *   - a spec with review fields passes the strict bucket and endpoint
 *     rules with staging's real B2 hosts and buckets, and is refused
 *     with the test configuration's `.test.example` working endpoint;
 *   - the committed schema file's SHA-256 is pinned, so an edit to the
 *     contract fails here until the runner's vendored copy is updated
 *     with it.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import schemaText from "../../app/lib/pipeline/run-spec.schema.json?raw";
import {
  validateRunSpec,
  validateAnyRunSpec,
  checkVolumePages,
  checkRunSpecInvariants,
  processingRunSpecSchema,
  runSpecSchema,
  RunSpecError,
  type RunSpec,
} from "../../app/lib/pipeline/run-spec";

const fixtures = import.meta.glob("../fixtures/media-pipeline/spec-*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

function fixture(name: string): unknown {
  const value = fixtures[`../fixtures/media-pipeline/${name}.json`];
  if (value === undefined) throw new Error(`missing fixture ${name}`);
  return structuredClone(value);
}

const SCHEMA_SHA256 = "d4e7667c9159f0f918d7998250cf4238af12c85b712f1d4c312bee750b5b1646";

// Schema-violation fixtures and the path the error must name (or a
// path inside it, such as `stages.tile.run`).
const SCHEMA_INVALID: Record<string, string> = {
  "tag-not-digest": "runner.image",
  "arch-arm64": "runner.arch",
  "tesseract-tonal": "volumes.0.recipe.output_class",
  "unknown-top-level-key": "priority",
  "tile-root-uppercase": "volumes.0.tile_root",
  "max-review-frac": "max_review_frac",
  "url-template-no-placeholder": "callback.url_template",
  "tile-run-false": "volumes.0.recipe.stages.tile",
  "callback-token-missing": "callback.token",
  "volume-no-restricted": "volumes.0.restricted",
  "volume-no-pages": "volumes.0.pages",
  "page-key-leading-dot": "volumes.0.pages.0",
  "page-key-slash": "volumes.0.pages.0",
  "page-master-and-pdf": "volumes.0.pages.0",
  "working-backend-r2": "working.backend",
  "volume-ocr-no-lang": "volumes.0.recipe.stages.ocr.params.lang",
  "volume-ocr-empty-lang": "volumes.0.recipe.stages.ocr.params.lang",
  "review-run-no-image-base-url": "review.image_base_url",
  "review-page-no-sha256": "volumes.0.pages.0.sha256",
  "review-prefix-dotdot": "volumes.0.review_prefix",
  "review-prefix-depth": "volumes.0.review_prefix",
  "review-purge-no-review": "review",
  "review-destination-endpoint": "destination.endpoint",
  "review-working-bucket": "working.bucket",
  "review-source-bucket": "volumes.0.source.bucket",
  "review-backend-r2": "review.backend",
  "quarter-turns-zero": "volumes.0.pages.0",
  "quarter-turns-item-pdf": "volumes.0.pages.0",
  "quarter-turns-review-page": "volumes.0.pages.0",
};

// Review fixtures the schema accepts and the cross-field checks refuse,
// with the one problem each must report.
const REVIEW_CROSS: Record<string, { path: string; rule: string }> = {
  "cross-review-bucket-shared": { path: "working.bucket", rule: "review_bucket_distinct" },
  "cross-review-prefix-repeated": { path: "volumes.0.review_purge.1", rule: "review_prefix_unique" },
  "cross-review-purge-item-pdf": { path: "volumes.0.review_purge", rule: "review_purge_kind" },
};

// Cross-field fixtures, the path and the rule each must report.
const PAGE_LEVEL: Record<string, { path: string; rule: string }> = {
  "cross-page-count": { path: "volumes.0.pages", rule: "page_count" },
  "cross-seq-gap": { path: "volumes.0.pages.2.seq", rule: "seq_contiguous" },
  "cross-page-key-repeated": { path: "volumes.0.pages.2.page_key", rule: "page_key_unique" },
  "cross-override-unlisted": {
    path: "volumes.0.recipe.page_overrides.0.page_key",
    rule: "override_page_listed",
  },
  "cross-master-key-outside-prefix": {
    path: "volumes.0.pages.1.master_key",
    rule: "master_key_under_prefix",
  },
  "cross-item-pdf-master-key": { path: "volumes.0.pages.1", rule: "pdf_page_required" },
  "cross-volume-run-source-key": { path: "volumes.0.source", rule: "source_prefix_required" },
};

const JOB_LEVEL: Record<string, { path: string; rule: string }> = {
  "cross-job-unknown-volume": { path: "jobs.0.volume_ids.1", rule: "job_volume_known" },
  "cross-volume-two-jobs": { path: "jobs.1.volume_ids.0", rule: "volume_in_one_job" },
  "cross-volume-no-job": { path: "volumes.1", rule: "volume_in_one_job" },
};

function refusal(spec: unknown, validate: (x: unknown) => unknown = validateAnyRunSpec): RunSpecError {
  try {
    validate(spec);
  } catch (err) {
    if (err instanceof RunSpecError) return err;
    throw err;
  }
  throw new Error("expected validateRunSpec to throw");
}

describe("valid run specs", () => {
  it.each(["spec-valid", "spec-valid-item-pdf", "spec-valid-small", "spec-valid-volume-ocr", "spec-valid-volume-quarter-turns"])(
    "%s passes",
    (name) => {
      const spec = validateRunSpec(fixture(name));
      expect(spec.spec_version).toBe(1);
      expect(checkRunSpecInvariants(spec)).toEqual([]);
    },
  );

  it("the full volume-run fixture lists all its pages", () => {
    const spec = validateRunSpec(fixture("spec-valid")) as RunSpec;
    expect(spec.volumes[0].expected_count).toBe(734);
    expect(spec.volumes[0].pages).toHaveLength(734);
  });

  it("the item-PDF fixture carries the fixed item-PDF recipe", () => {
    const spec = validateRunSpec(fixture("spec-valid-item-pdf"));
    const recipe = spec.volumes[0].recipe;
    expect(spec.kind).toBe("item_pdf");
    expect(recipe.output_class).toBe("tonal");
    expect(recipe.stages.ocr).toEqual({ run: true, params: { engine: "pdf_text_layer" } });
    expect(recipe.stages.preprocess.run).toBe(false);
    expect(recipe.page_overrides).toEqual([]);
  });
});

describe("schema violations", () => {
  it.each(Object.entries(SCHEMA_INVALID))("%s is refused at %s", (name, path) => {
    const err = refusal(fixture(`spec-invalid-${name}`));
    const named = err.problems.filter((p) => p.path === path || p.path.startsWith(`${path}.`));
    expect(named.length).toBeGreaterThan(0);
    expect(err.message).toContain(named[0].path);
    expect(runSpecSchema.safeParse(fixture(`spec-invalid-${name}`)).success).toBe(false);
  });

  it("holds Tesseract OCR to bilevel output when the engine is omitted", () => {
    const spec = fixture("spec-valid-small") as RunSpec;
    spec.volumes[0].recipe.stages.ocr = { run: true, params: { lang: "spa" } };
    expect(refusal(spec).problems.map((p) => p.path)).toContain(
      "volumes.0.recipe.output_class",
    );
    spec.volumes[0].recipe.output_class = "bilevel";
    expect(() => validateRunSpec(spec)).not.toThrow();
  });

  it("asks a volume run's OCR stage for a language, and an item PDF's for none", () => {
    const volume = fixture("spec-valid-volume-ocr") as RunSpec;
    const ocr = volume.volumes[0].recipe.stages.ocr as { run: true; params: Record<string, unknown> };
    delete ocr.params.lang;
    expect(refusal(volume).problems.map((p) => p.path)).toContain(
      "volumes.0.recipe.stages.ocr.params.lang",
    );
    ocr.params.lang = 7;
    expect(refusal(volume).problems.map((p) => p.path)).toContain(
      "volumes.0.recipe.stages.ocr.params.lang",
    );

    const item = fixture("spec-valid-item-pdf") as RunSpec;
    expect(item.volumes[0].recipe.stages.ocr).toEqual({
      run: true,
      params: { engine: "pdf_text_layer" },
    });
    expect(() => validateRunSpec(item)).not.toThrow();
  });

  it("refuses an image reference with no repository before the digest", () => {
    const spec = fixture("spec-valid-small") as RunSpec;
    spec.runner.image = `@sha256:${"0".repeat(64)}`;
    expect(refusal(spec).problems.map((p) => p.path)).toContain("runner.image");
  });
});

describe("page digests", () => {
  const DIGEST = "0123456789abcdef".repeat(4);

  it("accepts a volume-run page with a digest beside pages without one", () => {
    const spec = fixture("spec-valid-small") as RunSpec;
    (spec.volumes[0].pages[0] as { sha256?: string }).sha256 = DIGEST;
    const parsed = validateRunSpec(spec);
    expect(parsed.volumes[0].pages[0]).toMatchObject({ sha256: DIGEST });
    expect("sha256" in parsed.volumes[0].pages[1]).toBe(false);
  });

  it.each([
    ["upper case", DIGEST.toUpperCase()],
    ["63 characters", DIGEST.slice(1)],
    ["65 characters", `${DIGEST}0`],
    ["a character outside hex", `g${DIGEST.slice(1)}`],
    ["null", null],
  ])("refuses a digest of %s", (_name, digest) => {
    const spec = fixture("spec-valid-small") as RunSpec;
    (spec.volumes[0].pages[0] as Record<string, unknown>).sha256 = digest;
    expect(refusal(spec).problems.some((p) => p.path.startsWith("volumes.0.pages.0"))).toBe(true);
  });

  it("refuses a digest on an item-PDF page", () => {
    const spec = fixture("spec-valid-item-pdf") as RunSpec;
    (spec.volumes[0].pages[0] as Record<string, unknown>).sha256 = DIGEST;
    expect(refusal(spec).problems.some((p) => p.path.startsWith("volumes.0.pages.0"))).toBe(true);
  });
});

describe("quarter turns", () => {
  it("keeps each page's turn, and leaves the field off a page without one", () => {
    const spec = validateRunSpec(fixture("spec-valid-volume-quarter-turns"));
    expect(spec.volumes[0].pages.map((p) => (p as { quarter_turns?: number }).quarter_turns)).toEqual([1, 2, 3]);
    const small = validateRunSpec(fixture("spec-valid-small"));
    expect(small.volumes[0].pages.every((p) => !("quarter_turns" in p))).toBe(true);
  });

  it.each([
    ["0", 0],
    ["4", 4],
    ["a string", "1"],
    ["a fraction", 1.5],
    ["null", null],
  ])("refuses a turn of %s", (_name, turns) => {
    const spec = fixture("spec-valid-small") as RunSpec;
    (spec.volumes[0].pages[0] as Record<string, unknown>).quarter_turns = turns;
    expect(refusal(spec).problems.some((p) => p.path.startsWith("volumes.0.pages.0"))).toBe(true);
  });
});

describe("rotate_deg", () => {
  it.each([0, 90, 180, 270])("keeps %d on a volume-run page and on a review run's page", (degrees) => {
    const spec = fixture("spec-valid-small") as RunSpec;
    (spec.volumes[0].pages[0] as Record<string, unknown>).rotate_deg = degrees;
    (spec.volumes[0].pages[0] as Record<string, unknown>).quarter_turns = 1;
    const parsed = validateRunSpec(spec);
    expect(parsed.volumes[0].pages[0]).toMatchObject({ rotate_deg: degrees, quarter_turns: 1 });
    expect("rotate_deg" in parsed.volumes[0].pages[1]).toBe(false);

    const review = fixture("spec-valid-review-run") as { volumes: Array<{ pages: Record<string, unknown>[] }> };
    review.volumes[0].pages[0].rotate_deg = degrees;
    expect((validateAnyRunSpec(review) as typeof review).volumes[0].pages[0].rotate_deg).toBe(degrees);
  });

  it.each([
    ["45", 45],
    ["360", 360],
    ["-90", -90],
    ["a string", "90"],
    ["a fraction", 90.5],
    ["null", null],
  ])("refuses %s", (_name, degrees) => {
    const spec = fixture("spec-valid-small") as RunSpec;
    (spec.volumes[0].pages[0] as Record<string, unknown>).rotate_deg = degrees;
    expect(refusal(spec).problems.some((p) => p.path.startsWith("volumes.0.pages.0"))).toBe(true);
  });

  it("refuses it on an item-PDF page", () => {
    const spec = fixture("spec-valid-item-pdf") as RunSpec;
    (spec.volumes[0].pages[0] as Record<string, unknown>).rotate_deg = 90;
    expect(refusal(spec).problems.some((p) => p.path.startsWith("volumes.0.pages.0"))).toBe(true);
  });
});

describe("cross-field violations", () => {
  it.each(Object.entries(PAGE_LEVEL))("%s fails one page rule", (name, expected) => {
    const raw = fixture(`spec-invalid-${name}`);
    const parsed = processingRunSpecSchema.parse(raw);
    const volume = parsed.volumes[0];
    const problems = checkVolumePages(parsed.kind, volume);
    expect(problems).toHaveLength(1);
    expect(`volumes.0.${problems[0].path}`).toBe(expected.path);
    expect(problems[0].rule).toBe(expected.rule);

    const err = refusal(raw);
    expect(err.problems).toEqual([expected]);
    expect(err.message).toContain(expected.path);
    expect(err.message).toContain(expected.rule);
  });

  it.each(Object.entries(JOB_LEVEL))("%s fails one job rule", (name, expected) => {
    const raw = fixture(`spec-invalid-${name}`);
    const parsed = processingRunSpecSchema.parse(raw);
    for (const volume of parsed.volumes) {
      expect(checkVolumePages(parsed.kind, volume)).toEqual([]);
    }
    expect(checkRunSpecInvariants(parsed)).toEqual([expected]);
    expect(refusal(raw).problems).toEqual([expected]);
  });

  it("refuses repeated volume ids and repeated job indices", () => {
    const spec = processingRunSpecSchema.parse(fixture("spec-valid-small"));
    spec.volumes.push(structuredClone(spec.volumes[0]));
    expect(checkRunSpecInvariants(spec).map((p) => p.rule)).toContain("volume_id_unique");

    const jobs = processingRunSpecSchema.parse(fixture("spec-valid-small"));
    jobs.volumes.push({ ...structuredClone(jobs.volumes[0]), volume_id: "pv_02" });
    jobs.jobs.push({ job_index: 0, volume_ids: ["pv_02"] });
    expect(checkRunSpecInvariants(jobs)).toEqual([
      { path: "jobs.1.job_index", rule: "job_index_unique" },
    ]);
  });

  it("refuses a master key equal to the source prefix", () => {
    const spec = processingRunSpecSchema.parse(fixture("spec-valid-small"));
    const volume = spec.volumes[0];
    (volume.pages[0] as { master_key: string }).master_key = (
      volume.source as { prefix: string }
    ).prefix;
    expect(checkVolumePages("volume_run", volume)).toEqual([
      { path: "pages.0.master_key", rule: "master_key_under_prefix" },
    ]);
  });
});

describe("review runs and review purges", () => {
  it.each(["spec-valid-review-run", "spec-valid-review-purge", "spec-valid-volume-review-purge"])(
    "%s passes the validator for any kind",
    (name) => {
      const spec = validateAnyRunSpec(fixture(name));
      expect(checkRunSpecInvariants(spec)).toEqual([]);
    },
  );

  it("passes a volume run that purges review prefixes as a processing spec", () => {
    const spec = validateRunSpec(fixture("spec-valid-volume-review-purge"));
    expect(spec.volumes[0].review_purge).toHaveLength(2);
    expect(spec.review?.bucket).toBe("test-review-tiles");
  });

  it("refuses a review run or a purge run as a processing spec", () => {
    for (const name of ["spec-valid-review-run", "spec-valid-review-purge"]) {
      expect(refusal(fixture(name), validateRunSpec).problems).toEqual([{ path: "kind", rule: "processing_kind" }]);
    }
  });

  it("holds a spec without review fields to the rules it met before", () => {
    // The small fixture's endpoints are not B2 hosts; with no review
    // field nothing checks them.
    expect(() => validateRunSpec(fixture("spec-valid-small"))).not.toThrow();
    const spec = fixture("spec-valid-small") as RunSpec;
    spec.review = { backend: "b2", endpoint: "https://s3.test-000.backblazeb2.com", bucket: "test-review-tiles" };
    const paths = refusal(spec).problems.map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining(["destination.endpoint", "working.endpoint", "volumes.0.source.endpoint"]));
  });

  // Staging's tiles, masters, working and review stores as its
  // federation row and its Worker settings name them.
  function stagingForm(spec: RunSpec): RunSpec {
    const b2 = "https://s3.us-west-001.backblazeb2.com";
    spec.destination.endpoint = b2;
    spec.destination.tiles_bucket = "ampl-staging-iiif-tiles";
    spec.destination.ocr_bucket = "ampl-staging-iiif-tiles";
    spec.working.endpoint = b2;
    spec.working.bucket = "fisqua-pipeline-working-staging";
    spec.volumes[0].source.endpoint = b2;
    spec.volumes[0].source.bucket = "ampl-masters";
    spec.review = { backend: "b2", endpoint: b2, bucket: "ampl-staging-review-tiles" };
    spec.volumes[0].review_purge = ["ampl/0c1d2e3f-4a5b-4c6d-8e7f-001122334455/"];
    return spec;
  }

  it("passes staging's real stores under the strict rules, and refuses the test working endpoint", () => {
    const spec = validateRunSpec(stagingForm(fixture("spec-valid-volume-quarter-turns") as RunSpec));
    expect(spec.review?.bucket).toBe("ampl-staging-review-tiles");

    const test = stagingForm(fixture("spec-valid-small") as RunSpec);
    test.working.endpoint = "https://s3.us-west-000.backblazeb2.test.example";
    expect(refusal(test).problems.map((p) => p.path)).toEqual(["working.endpoint"]);
  });

  it("follows a review run's pages with a volume run's page rules", () => {
    const spec = fixture("spec-valid-review-run") as { volumes: Array<{ expected_count: number }> };
    spec.volumes[0].expected_count = 4;
    expect(refusal(spec).problems).toEqual([{ path: "volumes.0.pages", rule: "page_count" }]);
  });

  it.each(Object.entries(REVIEW_CROSS))("%s fails one rule", (name, expected) => {
    const raw = fixture(`spec-invalid-${name}`);
    expect(runSpecSchema.safeParse(raw).success).toBe(true);
    expect(refusal(raw).problems).toEqual([expected]);
  });
});

describe("schema file", () => {
  it("matches the pinned SHA-256 of the committed bytes", async () => {
    const bytes = new TextEncoder().encode(schemaText);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(SCHEMA_SHA256);
  });
});

// @version v0.8.0
