/**
 * EAD3 RNG Schema Validation
 *
 * This suite is the structural RNG-validation layer. Every emitted EAD3 document —
 * across the three profile × level matrix — validates against the
 * vendored SAA-SDT v1.1.x compiled grammar via xmllint-wasm. If a
 * document fails RNG validation, the test surfaces the structural
 * error and the EAD builder (`app/lib/export/ead/builder.ts`) is
 * iterated until validation passes.
 *
 * The schema-load smoke guard test MUST be green for these results
 * to be trustworthy. If the WASM blob ever silently fails to load,
 * the canary in `schema-load-guard.test.ts` goes RED before this
 * suite emits a misleading GREEN.
 *
 * Runs under the Node test pool (`vitest.node.config.ts`) because
 * `xmllint-wasm` calls `node:fs` to load its own WASM blob, which the
 * Workers pool sandbox does not expose.
 *
 * @version v0.4.0
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { validateXML } from "xmllint-wasm";
import { buildEad3 } from "../../../app/lib/export/ead/builder";
import { ISADG_EAD_PROFILE } from "../../../app/lib/export/ead/profiles/isadg";
import { DACS_EAD_PROFILE } from "../../../app/lib/export/ead/profiles/dacs";
import { RAD_EAD_PROFILE } from "../../../app/lib/export/ead/profiles/rad";
import { sampleFondsRows, sampleRepositoryById } from "./fixtures";
import type { EadInput } from "../../../app/lib/export/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RNG_PATH = path.resolve(__dirname, "../../fixtures/ead3/ead3.rng");

const CREATE_DATE = "2026-05-04T10:00:00Z";

let ead3Rng: string;
beforeAll(async () => {
  ead3Rng = await readFile(RNG_PATH, "utf8");
});

const PROFILES = [
  ["isadg", ISADG_EAD_PROFILE],
  ["dacs", DACS_EAD_PROFILE],
  ["rad", RAD_EAD_PROFILE],
] as const;

async function assertValid(xml: string, label: string): Promise<void> {
  const result = await validateXML({
    xml: [{ fileName: `${label}.xml`, contents: xml }],
    extension: "relaxng",
    schema: [{ fileName: "ead3.rng", contents: ead3Rng }],
  });
  if (!result.valid) {
    // Surface the FIRST error so iterating builder.ts is straightforward
    const first = result.errors[0]?.rawMessage ?? "<no message>";
    throw new Error(`${label} RNG validation failed: ${first}`);
  }
  expect(result.valid).toBe(true);
}

describe("EAD3 RNG validation — fonds with descendant tree", () => {
  for (const [name, profile] of PROFILES) {
    it(`emits valid EAD3 for the ${name} profile across fonds → series → file → item`, async () => {
      const xml = buildEad3(
        sampleFondsRows as readonly EadInput[],
        sampleRepositoryById,
        profile,
        CREATE_DATE,
      );
      await assertValid(xml, `${name}-multi-level`);
    });
  }
});

describe("EAD3 RNG validation — single-level fonds (no descendants)", () => {
  const singleLevel = sampleFondsRows.filter((r) => r.descriptionLevel === "fonds");
  for (const [name, profile] of PROFILES) {
    it(`emits valid EAD3 for the ${name} profile with a single-level fonds`, async () => {
      const xml = buildEad3(
        singleLevel as readonly EadInput[],
        sampleRepositoryById,
        profile,
        CREATE_DATE,
      );
      await assertValid(xml, `${name}-single-level`);
    });
  }
});

describe("EAD3 RNG validation — DACS profile with adminBiogHistory populated", () => {
  it("emits valid EAD3 for DACS with <bioghist> in <archdesc> context", async () => {
    const fondsWithBiog: EadInput[] = sampleFondsRows.map((r, i) =>
      i === 0
        ? ({ ...r, adminBiogHistory: "Biographical history of the Gobernación" } as EadInput)
        : (r as EadInput),
    );
    const xml = buildEad3(fondsWithBiog, sampleRepositoryById, DACS_EAD_PROFILE, CREATE_DATE);
    await assertValid(xml, "dacs-with-bioghist");
  });
});

/* @version v0.4.0 */
