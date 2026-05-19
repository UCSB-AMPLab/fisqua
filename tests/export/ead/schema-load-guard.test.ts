/**
 * Tests — EAD3 Schema-Load Smoke Guard
 *
 * This test catches the silent-failure mode where `xmllint-wasm` reports
 * `valid: true` against an obviously-invalid XML input because the
 * RelaxNG grammar failed to load. If the validator silently accepts
 * `<not-ead/>`, every downstream EAD3 schema-validation test would
 * be a false positive; this test catches that first.
 *
 * Runs under the Node test pool (`vitest.node.config.ts` extension)
 * because `xmllint-wasm` calls `node:fs` to load its own WASM blob,
 * which the Workers pool sandbox does not expose.
 *
 * @version v0.4.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateXML } from "xmllint-wasm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RNG_PATH = path.resolve(__dirname, "../../fixtures/ead3/ead3.rng");

let ead3RngContents: string;

beforeAll(async () => {
  ead3RngContents = await readFile(RNG_PATH, "utf8");
});

describe("EAD3 RNG schema-load smoke guard", () => {
  it("rejects an obviously-invalid XML (canary for silent schema-load failure)", async () => {
    const result = await validateXML({
      xml: [
        {
          fileName: "doc.xml",
          contents: '<?xml version="1.0"?><not-ead/>',
        },
      ],
      extension: "relaxng",
      schema: [{ fileName: "ead3.rng", contents: ead3RngContents }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("schema file is non-empty and contains a grammar root", () => {
    expect(ead3RngContents.length).toBeGreaterThan(80_000);
    expect(ead3RngContents).toContain("<grammar");
  });
});
