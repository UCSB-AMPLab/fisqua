import { describe, it, expect, vi, beforeEach } from "vitest";
import { sampleManifest, sampleManifestUrl } from "../helpers/manifests";

// We'll import from the module under test once it exists
import {
  validateManifestUrl,
  parseManifest,
} from "../../app/lib/iiif.server";

describe("IIIF manifest parser", () => {
  describe("validateManifestUrl", () => {
    it("accepts a valid manifest URL", () => {
      const result = validateManifestUrl(sampleManifestUrl);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("rejects non-HTTPS URLs", () => {
      const result = validateManifestUrl(
        "http://iiif.zasqua.org/co-ahr-gob-caj259-car005/manifest.json"
      );
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/HTTPS/i);
    });

    it("rejects URLs from wrong host", () => {
      const result = validateManifestUrl(
        "https://evil.example.com/co-ahr-gob-caj259-car005/manifest.json"
      );
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/iiif\.zasqua\.org/);
    });

    it("rejects URLs not ending in /manifest.json", () => {
      const result = validateManifestUrl(
        "https://iiif.zasqua.org/co-ahr-gob-caj259-car005/info.json"
      );
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/manifest\.json/);
    });

    it("rejects invalid URL format", () => {
      const result = validateManifestUrl("not a url");
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Invalid URL/i);
    });
  });

  describe("parseManifest", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("extracts name from manifest.label.es[0]", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(sampleManifest), { status: 200 })
        )
      );

      const result = await parseManifest(sampleManifestUrl);
      expect(result.name).toBe("Carpeta 005, Caja 259");
    });

    it("extracts referenceCode from homepage URL", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(sampleManifest), { status: 200 })
        )
      );

      const result = await parseManifest(sampleManifestUrl);
      expect(result.referenceCode).toBe("co-ahr-gob-caj259-car005");
    });

    it("extracts page count, dimensions, and image URLs from canvases", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(sampleManifest), { status: 200 })
        )
      );

      const result = await parseManifest(sampleManifestUrl);
      expect(result.pageCount).toBe(3);
      expect(result.pages).toHaveLength(3);

      // First page
      expect(result.pages[0].position).toBe(1);
      expect(result.pages[0].width).toBe(3000);
      expect(result.pages[0].height).toBe(4000);
      expect(result.pages[0].imageUrl).toBe(
        "https://iiif.zasqua.org/tiles/co-ahr-gob-caj259-car005/page-001"
      );

      // Third page has different dimensions
      expect(result.pages[2].width).toBe(2900);
      expect(result.pages[2].height).toBe(4100);
    });

    it("falls back to label.none[0] when label.es is absent", async () => {
      const manifestNoEs = {
        ...sampleManifest,
        label: { none: ["Folder 005"] },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(manifestNoEs), { status: 200 })
        )
      );

      const result = await parseManifest(sampleManifestUrl);
      expect(result.name).toBe("Folder 005");
    });

    it("falls back to label.en[0] when label.es and label.none are absent", async () => {
      const manifestEn = {
        ...sampleManifest,
        label: { en: ["English Title"] },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(manifestEn), { status: 200 })
        )
      );

      const result = await parseManifest(sampleManifestUrl);
      expect(result.name).toBe("English Title");
    });

    it("throws on non-200 response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }))
      );

      await expect(parseManifest(sampleManifestUrl)).rejects.toThrow(
        /Failed to fetch manifest/
      );
    });

    it("throws when homepage field is missing", async () => {
      const manifestNoHomepage = { ...sampleManifest };
      delete (manifestNoHomepage as any).homepage;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(manifestNoHomepage), { status: 200 })
        )
      );

      await expect(parseManifest(sampleManifestUrl)).rejects.toThrow(
        /reference code/i
      );
    });

    it("stores the original manifest URL", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(sampleManifest), { status: 200 })
        )
      );

      const result = await parseManifest(sampleManifestUrl);
      expect(result.manifestUrl).toBe(sampleManifestUrl);
    });
  });
});
