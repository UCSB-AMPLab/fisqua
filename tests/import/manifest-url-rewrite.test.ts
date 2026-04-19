/**
 * Tests — manifest url rewrite
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("rewriteManifestUrl", () => {
  it("rewrites a manifest URL to canonical pattern using reference code", async () => {
    const { rewriteManifestUrl } = await import(
      "../../scripts/commands/descriptions"
    );

    const result = rewriteManifestUrl(
      "https://old.example.com/manifest.json",
      "co-ahr-gob-caj001-car001-f001r"
    );
    expect(result).toBe(
      "https://manifests.zasqua.org/co-ahr-gob-caj001-car001-f001r/manifest.json"
    );
  });

  it("returns null for null URL", async () => {
    const { rewriteManifestUrl } = await import(
      "../../scripts/commands/descriptions"
    );

    expect(rewriteManifestUrl(null, "co-ahr-gob-caj001")).toBeNull();
  });

  it("returns null for empty string URL", async () => {
    const { rewriteManifestUrl } = await import(
      "../../scripts/commands/descriptions"
    );

    expect(rewriteManifestUrl("", "co-ahr-gob-caj001")).toBeNull();
  });

  it("returns null for undefined URL", async () => {
    const { rewriteManifestUrl } = await import(
      "../../scripts/commands/descriptions"
    );

    expect(rewriteManifestUrl(undefined, "co-ahr-gob-caj001")).toBeNull();
  });

  it("strips ? and # from reference code in rewritten URL", async () => {
    const { rewriteManifestUrl } = await import(
      "../../scripts/commands/descriptions"
    );

    const result = rewriteManifestUrl(
      "https://old.example.com/m.json",
      "co-ahr-gob?foo#bar"
    );
    expect(result).toBe(
      "https://manifests.zasqua.org/co-ahr-gobfoobar/manifest.json"
    );
  });
});

describe("PK-to-UUID mapping output", () => {
  const OUTPUT_DIR = ".import";

  async function cleanOutput() {
    try {
      await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  beforeEach(cleanOutput);
  afterEach(cleanOutput);

  it("writes pk-uuid-mapping.json after import", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { idMap } = await importDescriptions(fixturePath, repoIdMap);

    const mappingPath = path.join(OUTPUT_DIR, "pk-uuid-mapping.json");
    const raw = await fs.readFile(mappingPath, "utf8");
    const mapping = JSON.parse(raw);

    expect(mapping).toHaveProperty("descriptions");
    expect(typeof mapping.descriptions).toBe("object");

    // All old PKs should be present as string keys
    for (const [oldId, newId] of idMap.entries()) {
      expect(mapping.descriptions[String(oldId)]).toBe(newId);
    }
  });
});
