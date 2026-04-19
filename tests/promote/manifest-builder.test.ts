/**
 * Tests — manifest builder
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { buildDocumentManifest } from "../../app/lib/promote/manifest-builder";
import type { ManifestSpec, VolumePage } from "../../app/lib/promote/types";

const BASE_URL = "https://manifests.zasqua.org";

/** Generate volume pages with realistic data */
function makeVolumePages(count: number): VolumePage[] {
  return Array.from({ length: count }, (_, i) => ({
    position: i + 1,
    width: 3000,
    height: 4000,
    imageUrl: `https://iiif.zasqua.org/tiles/vol-001/page-${i + 1}`,
    label: `f. ${i + 1}r`,
  }));
}

/** Default manifest spec */
function makeManifestSpec(
  overrides: Partial<ManifestSpec> = {}
): ManifestSpec {
  return {
    referenceCode: "test-001",
    title: "Test Document",
    startPage: 1,
    startY: 0,
    endPage: null,
    endY: null,
    ...overrides,
  };
}

describe("buildDocumentManifest", () => {
  it("produces manifest with 1 canvas for a single-page document", () => {
    const spec = makeManifestSpec({ startPage: 1, endPage: null });
    const pages = makeVolumePages(5);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    expect(manifest.items).toHaveLength(1);
  });

  it("produces 3 canvases for a multi-page document (pages 3-5)", () => {
    const spec = makeManifestSpec({ startPage: 3, endPage: 5 });
    const pages = makeVolumePages(10);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    expect(manifest.items).toHaveLength(3);
  });

  it("uses 'full' region in canvas body image URL (Level 0 safety)", () => {
    const spec = makeManifestSpec({ startPage: 1, startY: 0.3 });
    const pages = makeVolumePages(3);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    const imageId = manifest.items[0].items[0].items[0].body.id;
    expect(imageId).toContain("/full/max/0/default.jpg");
    expect(imageId).not.toContain("pct:");
  });

  it("sets canvas dimensions to match source page dimensions", () => {
    const spec = makeManifestSpec();
    const pages = makeVolumePages(1);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    const canvas = manifest.items[0];
    expect(canvas.width).toBe(3000);
    expect(canvas.height).toBe(4000);
  });

  it("has correct @context for IIIF Presentation API v3", () => {
    const spec = makeManifestSpec();
    const pages = makeVolumePages(1);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    expect(manifest["@context"]).toBe(
      "http://iiif.io/api/presentation/3/context.json"
    );
  });

  it("has type 'Manifest'", () => {
    const spec = makeManifestSpec();
    const pages = makeVolumePages(1);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    expect(manifest.type).toBe("Manifest");
  });

  it("sets manifest id to baseUrl/referenceCode/manifest.json", () => {
    const spec = makeManifestSpec({ referenceCode: "AHRB-d001" });
    const pages = makeVolumePages(1);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    expect(manifest.id).toBe(`${BASE_URL}/AHRB-d001/manifest.json`);
  });

  it("uses { es: [title] } format for manifest label", () => {
    const spec = makeManifestSpec({ title: "Carta de comercio" });
    const pages = makeVolumePages(1);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    expect(manifest.label).toEqual({ es: ["Carta de comercio"] });
  });

  it("has correct annotation structure on canvas items", () => {
    const spec = makeManifestSpec();
    const pages = makeVolumePages(1);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    const canvas = manifest.items[0];
    const annotationPage = canvas.items[0];
    expect(annotationPage.type).toBe("AnnotationPage");
    const annotation = annotationPage.items[0];
    expect(annotation.type).toBe("Annotation");
    expect(annotation.motivation).toBe("painting");
  });

  it("sets image service to ImageService3 with level0 profile", () => {
    const spec = makeManifestSpec();
    const pages = makeVolumePages(1);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    const service =
      manifest.items[0].items[0].items[0].body.service[0];
    expect(service.type).toBe("ImageService3");
    expect(service.profile).toBe("level0");
  });

  it("defaults to single page when endPage is null", () => {
    const spec = makeManifestSpec({
      startPage: 3,
      endPage: null,
    });
    const pages = makeVolumePages(5);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    expect(manifest.items).toHaveLength(1);
    // The single canvas should correspond to page 3
    const imageId = manifest.items[0].items[0].items[0].body.id;
    expect(imageId).toContain("page-3");
  });

  it("includes rights field with CC BY-NC 4.0 URI", () => {
    const spec = makeManifestSpec();
    const pages = makeVolumePages(1);
    const manifest = buildDocumentManifest(spec, pages, BASE_URL) as any;
    expect(manifest.rights).toBe(
      "http://creativecommons.org/licenses/by-nc/4.0/"
    );
  });
});
