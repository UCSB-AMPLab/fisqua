/**
 * Tests — media pipeline run spec builder
 *
 * `buildRunSpec` turns rows already read from D1 into the run spec the
 * runner reads. This suite pins what it takes from where:
 *
 *   - the tile root is the volume's reference code, copied byte for
 *     byte; a reference code outside the tile-root pattern is refused
 *     naming the volume, never rewritten;
 *   - the page list is the volume's page rows in `seq` order, master
 *     files for a volume run and PDF pages for an item PDF; a master
 *     page carries its row's digest when the row has one;
 *   - the callback URLs sit on the configured callback origin and the
 *     token is the one passed in; the destination's credentials name is
 *     derived from the tenant and the environment
 *     (`fisqua-pipeline-{tenantId}` in production,
 *     `fisqua-pipeline-staging-{tenantId}` on staging); the tiles prefix,
 *     OCR prefix and image address are the ones passed in, OCR in the
 *     tiles bucket; the working space is B2;
 *   - every volume entry says it is not restricted, and a restricted
 *     volume is refused;
 *   - the cross-field page checks run in the builder too, naming the
 *     volume and the rule;
 *   - the default manifest resolver refuses until the manifest inputs
 *     have a source;
 *   - the resolved recipe as stored on the run volume is byte-identical
 *     to the recipe in the spec.
 *
 * Manifest values here come from a test resolver and are test values.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, seedTenants } from "../helpers/db";
import { seedPipelineRun } from "../helpers/media-pipeline";
import { makeTenantContext } from "../helpers/context";
import { manifestResolver } from "../../app/lib/pipeline/manifest-inputs";
import {
  buildRunSpec,
  ManifestInputsError,
  RunSpecError,
  validateRunSpec,
  type BuildRunSpecInput,
  type BuildRunSpecVolume,
  type RunSpecRecipe,
} from "../../app/lib/pipeline/run-spec";
import { resolveRecipe, TONAL_DEFAULT_PRESET } from "../../app/lib/pipeline/recipe";
import { groupJobs } from "../../app/lib/pipeline/grouping";

const TENANT = "test-tenant";
const RUN_ID = "6f1b2a4e-0c3d-4e7f-9a51-2b8d7c6e5f10";
const TOKEN = "fpr_" + "T".repeat(43);
const IMAGE = "ghcr.io/example/runner@sha256:" + "0123456789abcdef".repeat(4);

const ACCEPTED = { preprocess: ["pad"], render: ["trim"] };

function recipeFor(kind: "volume_run" | "item_pdf"): RunSpecRecipe {
  return resolveRecipe(
    kind,
    {
      id: "decl-1",
      version: 2,
      platen: "v",
      background: "dark",
      outputClass: "tonal",
      ocr: false,
      ocrLang: null,
      tonePreset: "tonal-default",
      advancedParams: "{}",
    },
    { byOutputClass: { tonal: TONAL_DEFAULT_PRESET }, acceptedKeys: ACCEPTED },
    [],
  );
}

function volumeEntry(
  id: string,
  referenceCode: string,
  opts: { pages?: number; kind?: "volume_run" | "item_pdf"; restricted?: boolean } = {},
): BuildRunSpecVolume {
  const kind = opts.kind ?? "volume_run";
  const count = opts.pages ?? 3;
  const prefix = `masters/${referenceCode}/`;
  // Rows deliberately out of seq order: the builder sorts them.
  const pages = Array.from({ length: count }, (_, i) => {
    const seq = count - i;
    const pageKey = `p${String(seq).padStart(4, "0")}`;
    return {
      id: `${id}-page-${seq}`,
      tenantId: TENANT,
      pipelineVolumeId: id,
      seq,
      pageKey,
      masterKey: kind === "volume_run" ? `${prefix}${pageKey}.tif` : null,
      pdfPage: kind === "item_pdf" ? seq : null,
      sha256: null as string | null,
    };
  });
  return {
    volume: {
      id,
      tenantId: TENANT,
      descriptionId: `desc-${id}`,
      referenceCode,
      kind,
      state: "received",
      mastersBackend: "b2",
      mastersEndpoint: "https://s3.b2.test.example",
      mastersBucket: "test-ingest-bucket",
      mastersPrefix: kind === "volume_run" ? prefix : null,
      mastersKey: kind === "item_pdf" ? `ingest/${referenceCode}.pdf` : null,
      checksumsKey: null,
      expectedCount: count,
      recipeScopeDescriptionId: "scope",
      restricted: opts.restricted ?? false,
      restrictionCheckedAt: null,
      currentTileRoot: null,
      openReviewCount: 0,
      lastRunId: null,
      heldByRunId: null,
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
      pagesRevision: 0,
    },
    pages,
    recipe: recipeFor(kind),
    description: { id: `desc-${id}`, title: "Test description title" } as any,
    repository: { id: "repo", name: "Test repository" } as any,
  };
}

const testResolver: BuildRunSpecInput["manifestResolver"] = (volume) => ({
  id: `https://iiif.test.example/${volume.referenceCode}/manifest.json`,
  label: { es: ["Test description title"] },
  homepage: [
    { id: `https://zasqua.test.example/${volume.referenceCode}`, type: "Text", format: "text/html", label: { es: ["Test"] } },
  ],
  rights: null,
  required_statement: null,
  provider: [],
});

function input(volumes: BuildRunSpecVolume[], kind: "volume_run" | "item_pdf" = "volume_run"): BuildRunSpecInput {
  const jobs = groupJobs(
    volumes.map((v) => ({ id: v.volume.id, referenceCode: v.volume.referenceCode, expectedCount: v.volume.expectedCount })),
    734,
  );
  return {
    runId: RUN_ID,
    tenantId: TENANT,
    environment: "production",
    kind,
    createdAt: Date.UTC(2026, 10, 2, 14),
    runner: { image: IMAGE, scriptVersion: "v1.0.0" },
    callback: { origin: "https://fisqua.test", token: TOKEN, tokenExpiresAt: Date.UTC(2026, 10, 3, 2, 0, 0, 123) },
    maxReviewFrac: 0.1,
    destination: {
      endpoint: "https://s3.b2.test.example",
      tilesBucket: "zasqua-iiif-tiles",
      tilesPrefix: "neogranadina/",
      imageBaseUrl: "https://tiles.test.example/neogranadina",
      ocrPrefix: "neogranadina/ocr/",
    },
    working: { endpoint: "https://s3.b2.test.example", bucket: "test-working-bucket" },
    jobs,
    volumes,
    tenant: makeTenantContext({ id: TENANT }),
    manifestResolver: testResolver,
  };
}

function thrown(fn: () => unknown): RunSpecError {
  try {
    fn();
  } catch (err) {
    return err as RunSpecError;
  }
  throw new Error("expected a throw");
}

describe("run spec builder", () => {
  it("builds a spec that passes validation, with every field from its source", () => {
    const codes = ["co-ahrb-aht-008", "pe.bn_cdip-0001", "a-b.c_d"];
    const volumes = codes.map((code, i) => volumeEntry(`pv_${i}`, code));
    const spec = buildRunSpec(input(volumes));
    expect(() => validateRunSpec(spec)).not.toThrow();
    spec.volumes.forEach((entry, i) => {
      expect(entry.reference_code).toBe(codes[i]);
      expect(entry.tile_root).toBe(codes[i]);
      expect(entry.restricted).toBe(false);
      expect(entry.pages.map((p) => p.seq)).toEqual([1, 2, 3]);
      expect(entry.pages[0]).toEqual({
        seq: 1,
        page_key: "p0001",
        master_key: `masters/${codes[i]}/p0001.tif`,
      });
      expect(entry.source).toEqual({
        backend: "b2",
        endpoint: "https://s3.b2.test.example",
        bucket: "test-ingest-bucket",
        prefix: `masters/${codes[i]}/`,
        checksums_key: null,
      });
    });
    expect(spec.callback).toEqual({
      url_template: `https://fisqua.test/api/pipeline/runs/${RUN_ID}/volumes/{volume_id}/callback`,
      complete_url: `https://fisqua.test/api/pipeline/runs/${RUN_ID}/complete`,
      token_expires_at: "2026-11-03T02:00:00.123Z",
      token: TOKEN,
    });
    expect(Date.parse(spec.callback.token_expires_at)).toBe(Date.UTC(2026, 10, 3, 2, 0, 0, 123));
    expect(spec.destination.credentials_ref).toBe(`fisqua-pipeline-${TENANT}`);
    expect(spec.destination.ocr_bucket).toBe(spec.destination.tiles_bucket);
    expect(spec.destination.tiles_prefix).toBe("neogranadina/");
    expect(spec.destination.image_base_url).toBe("https://tiles.test.example/neogranadina");
    expect(spec.destination.ocr_prefix).toBe("neogranadina/ocr/");
    expect(spec.working).toEqual({
      backend: "b2",
      endpoint: "https://s3.b2.test.example",
      bucket: "test-working-bucket",
      prefix: `${TENANT}/pipeline-runs/${RUN_ID}/`,
    });
  });

  it("names the staging key store on staging", () => {
    const spec = buildRunSpec({ ...input([volumeEntry("pv", "co-m-001")]), environment: "staging" });
    expect(spec.destination.credentials_ref).toBe(`fisqua-pipeline-staging-${TENANT}`);
    expect(() => validateRunSpec(JSON.parse(JSON.stringify(spec)))).not.toThrow();
  });

  it("refuses a reference code outside the tile-root pattern and does not rewrite it", () => {
    for (const code of ["Co-ahrb-008", "co/ahrb/008"]) {
      const err = thrown(() => buildRunSpec(input([volumeEntry("pv_bad", code)])));
      expect(err).toBeInstanceOf(RunSpecError);
      expect(err.problems[0].rule).toBe("invalid_reference_code");
      expect(err.problems[0].volumeId).toBe("pv_bad");
      expect(err.message).toContain("pv_bad");
    }
  });

  it("refuses a restricted volume", () => {
    const err = thrown(() => buildRunSpec(input([volumeEntry("pv_r", "co-r-001", { restricted: true })])));
    expect(err.problems[0]).toMatchObject({ rule: "restricted", volumeId: "pv_r" });
  });

  it("builds an item PDF from its source object and PDF pages", () => {
    const spec = buildRunSpec(input([volumeEntry("pv_pdf", "pe-bn-cdip-00001", { kind: "item_pdf", pages: 2 })], "item_pdf"));
    expect(() => validateRunSpec(spec)).not.toThrow();
    const entry = spec.volumes[0];
    expect(entry.source).toMatchObject({ key: "ingest/pe-bn-cdip-00001.pdf" });
    expect("prefix" in entry.source).toBe(false);
    expect(entry.pages).toEqual([
      { seq: 1, page_key: "p0001", pdf_page: 1 },
      { seq: 2, page_key: "p0002", pdf_page: 2 },
    ]);
  });

  it("copies a page row's digest into its entry and leaves it out where the row has none", () => {
    const digest = "89abcdef01234567".repeat(4);
    const v = volumeEntry("pv_sha", "co-sha-001");
    v.pages = v.pages.map((p) => (p.seq === 2 ? { ...p, sha256: digest } : p));
    const spec = buildRunSpec(input([v]));
    const pages = spec.volumes[0].pages;
    expect(pages[1]).toEqual({
      seq: 2,
      page_key: "p0002",
      master_key: "masters/co-sha-001/p0002.tif",
      sha256: digest,
    });
    expect("sha256" in pages[0]).toBe(false);
    expect("sha256" in pages[2]).toBe(false);
  });

  it("refuses a page row whose digest is not lowercase hex", () => {
    const v = volumeEntry("pv_bad_sha", "co-sha-002");
    v.pages = v.pages.map((p) => (p.seq === 1 ? { ...p, sha256: "ABCDEF".padEnd(64, "0") } : p));
    expect(() => buildRunSpec(input([v]))).toThrow(RunSpecError);
  });

  it("refuses a page list one short of the expected count, naming the volume and rule", () => {
    const v = volumeEntry("pv_short", "co-s-001");
    v.pages = v.pages.filter((p) => p.seq !== 3);
    const err = thrown(() => buildRunSpec(input([v])));
    expect(err.problems[0]).toMatchObject({ rule: "page_count", volumeId: "pv_short" });
  });

  it("refuses a master key outside the source prefix, naming the volume and rule", () => {
    const v = volumeEntry("pv_out", "co-o-001");
    v.pages[0] = { ...v.pages[0], masterKey: "elsewhere/p.tif" };
    const err = thrown(() => buildRunSpec(input([v])));
    expect(err.problems[0]).toMatchObject({ rule: "master_key_under_prefix", volumeId: "pv_out" });
  });

  it("passes a resolver's refusal through with its code", () => {
    const spec = input([volumeEntry("pv", "co-m-001")]);
    spec.manifestResolver = () => {
      throw new ManifestInputsError("no rights", "repository_rights_unset", { repository_code: "repo" });
    };
    let caught: unknown;
    try {
      buildRunSpec(spec);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ManifestInputsError);
    expect((caught as ManifestInputsError).code).toBe("repository_rights_unset");
    expect((caught as ManifestInputsError).detail).toEqual({ repository_code: "repo" });
  });

  it("builds a spec that passes validation with the real manifest resolver", () => {
    const entry = volumeEntry("pv", "co-m-001");
    entry.description = {
      ...entry.description,
      referenceCode: "co-m-001",
      dateExpression: "1700 .. 1710",
      extent: "10 folios",
      language: "173",
      accessConditions: null,
      scopeContent: "Nota de alcance",
    } as any;
    entry.repository = {
      id: "repo",
      code: "co-m",
      name: "Test repository",
      city: "Test city",
      manifestRights: "https://rights.example.test/",
      attributionEn: "English attribution",
      attributionEs: "Atribución en español",
    } as any;
    for (const tenant of [
      makeTenantContext({ id: TENANT }),
      makeTenantContext({
        id: TENANT,
        publicSiteUrl: "https://site.example.test",
        publicSiteName: "Site",
        providerName: "Provider",
        providerUrl: "https://provider.example.test/",
        metsBaseUrl: "https://files.example.test/mets",
      }),
    ]) {
      const spec = { ...input([entry]), tenant, manifestResolver: manifestResolver("https://manifests.example.test") };
      const built = buildRunSpec(spec);
      expect(() => validateRunSpec(JSON.parse(JSON.stringify(built)))).not.toThrow();
      expect(built.volumes[0].manifest.id).toBe("https://manifests.example.test/iiif/co-m-001/manifest.json");
    }
  });

  it("hands the resolver each volume's description and repository, and the run's tenant", () => {
    const seen: unknown[] = [];
    const spec = input([volumeEntry("pv", "co-m-001")]);
    spec.manifestResolver = (volume, description, repository, tenant) => {
      seen.push([volume.id, description?.id, repository?.id, tenant.id]);
      return testResolver(volume, description, repository, tenant);
    };
    buildRunSpec(spec);
    expect(seen).toEqual([["pv", "desc-pv", "repo", TENANT]]);
  });

  describe("with D1", () => {
    beforeAll(async () => {
      await applyMigrations();
    });
    beforeEach(async () => {
      await cleanDatabase();
      await seedTenants();
    });

    it("stores the resolved recipe byte-identically to the spec's recipe", async () => {
      const run = await seedPipelineRun();
      const entry = volumeEntry("pv_rt", "co-rt-001");
      // The ledger stores the resolved recipe as resolved; the spec is
      // serialised once and read by the runner.
      await env.DB.prepare("UPDATE pipeline_run_volumes SET resolved_recipe = ? WHERE id = ?")
        .bind(JSON.stringify(entry.recipe), run.volumes[0].runVolumeId)
        .run();
      const specJson = JSON.stringify(buildRunSpec(input([entry])));
      const row = await env.DB.prepare("SELECT resolved_recipe FROM pipeline_run_volumes WHERE id = ?")
        .bind(run.volumes[0].runVolumeId)
        .first<{ resolved_recipe: string }>();
      expect(row!.resolved_recipe).toBe(JSON.stringify(JSON.parse(specJson).volumes[0].recipe));
    });
  });
});

// @version v0.8.0
