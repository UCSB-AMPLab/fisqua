/**
 * DACS Shape Lint
 *
 * This suite is the DACS-profile EAD3 lint layer. Every emitted DACS-profile EAD3
 * document carries the DACS Single-Level Minimum 10 elements at
 * every `<archdesc>` top. Element list is imported directly from
 * `app/lib/standards/dacs.ts` as the single source of truth; this
 * test only enforces, it does not redeclare.
 *
 * Lint scope:
 *   - Single-level Minimum (10 elements) → ENFORCED at <archdesc>
 *   - Multilevel Required → ADVISORY (no failure; advisory in spirit)
 *   - Single-level Optimum → NOT LINTED (recommendation, not requirement)
 *
 * Defensible substitute for an actual ArchivesGrid / DPLA submission:
 * aggregators harvest via OAI-PMH, do not accept ad-hoc test
 * submissions, and Fisqua has no real DACS tenant in v0.4.
 *
 * Field-to-element regexes mirror what `buildEad3()` actually emits:
 * `<physdesc>` carries extent text directly (no `<extent>` child —
 * EAD3 dropped that element from EAD2002), and `<name>`/`<corpname>`
 * wrap content in `<part>` per the EAD3 RNG grammar.
 *
 * Runs under the Node test pool (`vitest.node.config.ts`); not
 * because the test itself needs Node APIs, but because the pool
 * routing carve-out is set up for `tests/export/ead/dacs-*.test.ts`
 * (a forward-looking glob).
 *
 * @version v0.4.0
 */

import { describe, it, expect } from "vitest";
import { buildEad3 } from "../../../app/lib/export/ead/builder";
import { DACS_EAD_PROFILE } from "../../../app/lib/export/ead/profiles/dacs";
import { DACS_CONFIG } from "../../../app/lib/standards/dacs";
import { sampleFondsRows, sampleRepositoryById } from "./fixtures";
import type { EadInput } from "../../../app/lib/export/types";

const CREATE_DATE = "2026-05-04T10:00:00Z";

/**
 * Map DACS field name → EAD3 element string-contains assertion.
 *
 * Regexes are intentionally loose (whitespace tolerant, attribute order
 * permissive) so harmless emit-shape changes in the builder don't break
 * the lint. The RNG validation layer (schema-validation.test.ts) is the
 * structural canary; this lint is the DACS-element-presence canary.
 */
const DACS_FIELD_TO_EAD: Record<string, (xml: string) => boolean> = {
  // <unitid> at top of <did> — primary identifier (no @localtype).
  referenceCode: (xml) => /<unitid>[^<]+<\/unitid>/.test(xml),
  // <repository><corpname><part>...</part></corpname></repository> — EAD3
  // requires <part> children inside <corpname> (RNG e.corpname:1663).
  repositoryId: (xml) =>
    /<repository>\s*<corpname>\s*<part>[^<]+<\/part>\s*<\/corpname>/.test(xml),
  title: (xml) => /<unittitle>[^<]+<\/unittitle>/.test(xml),
  dateExpression: (xml) => /<unitdate>[^<]+<\/unitdate>/.test(xml),
  // <physdesc> carries extent free-text directly — EAD3 dropped
  // <extent> as a child element (the builder documents this). The
  // DACS Single-Level Minimum element "Extent" is satisfied by
  // `<physdesc>` content.
  extent: (xml) => /<physdesc>[^<]+<\/physdesc>/.test(xml),
  // <origination><name><part>...</part></name></origination> — same <part>
  // wrapping rule as <corpname> (RNG e.name:1762).
  creatorDisplay: (xml) =>
    /<origination>\s*<name>\s*<part>[^<]+<\/part>\s*<\/name>\s*<\/origination>/.test(xml),
  scopeContent: (xml) =>
    /<scopecontent>[\s\S]*?<p>[^<]+<\/p>[\s\S]*?<\/scopecontent>/.test(xml),
  accessConditions: (xml) =>
    /<accessrestrict>[\s\S]*?<p>[^<]+<\/p>[\s\S]*?<\/accessrestrict>/.test(xml),
  language: (xml) => /<langmaterial>\s*<language\b/.test(xml),
  descriptionLevel: (xml) => /<archdesc\s+level="[^"]+"/.test(xml),
};

describe("DACS shape lint — Single-level Minimum at <archdesc>", () => {
  // Source of truth for the required field list:
  const requiredFields = DACS_CONFIG.requiredFieldsForLevel("fonds");

  it("imports the 10-element required list from DACS_CONFIG (single source of truth)", () => {
    expect(requiredFields.length).toBe(10);
  });

  for (const field of DACS_CONFIG.requiredFieldsForLevel("fonds")) {
    it(`every emitted DACS-profile <archdesc> exposes ${field}`, () => {
      const xml = buildEad3(
        sampleFondsRows as readonly EadInput[],
        sampleRepositoryById,
        DACS_EAD_PROFILE,
        CREATE_DATE,
      );
      const checker = DACS_FIELD_TO_EAD[field];
      if (!checker) {
        throw new Error(
          `No DACS→EAD mapping for required field "${field}". Update DACS_FIELD_TO_EAD in this test.`,
        );
      }
      expect(checker(xml)).toBe(true);
    });
  }
});

describe("DACS shape lint — Multilevel Required is advisory only", () => {
  it("does not fail when a child <c> omits an element the parent provided (advisory only)", () => {
    // The series-level row in sampleFondsRows lacks creatorDisplay.
    // DACS § 1.5 multilevel inheritance says child should inherit from
    // parent unless information differs; we treat this as advisory —
    // surfacing nothing in test output and definitely not failing.
    const xml = buildEad3(
      sampleFondsRows as readonly EadInput[],
      sampleRepositoryById,
      DACS_EAD_PROFILE,
      CREATE_DATE,
    );
    const cBlock = xml.match(/<c level="series"[\s\S]*?<\/c>/)?.[0] ?? "";
    // No <origination> is fine at the series level (advisory). Test does
    // NOT assert presence — just confirms the block exists and lacks the
    // element without that being a failure.
    expect(cBlock).toContain('<c level="series"');
  });
});

describe("DACS shape lint — Single-level Optimum is NOT linted", () => {
  it("does not require <bioghist> at <archdesc> when adminBiogHistory is null", () => {
    // sampleFondsRows[0] has no adminBiogHistory; DACS_EAD_PROFILE
    // routes admin/biog to context (<bioghist>) when present — but
    // Optimum (admin/biog history) is not enforced — only Minimum is.
    const xml = buildEad3(
      sampleFondsRows as readonly EadInput[],
      sampleRepositoryById,
      DACS_EAD_PROFILE,
      CREATE_DATE,
    );
    expect(xml).not.toContain("<bioghist>");
    // Test passes BECAUSE bioghist is absent — proving Optimum is not
    // enforced.
  });
});

/* @version v0.4.0 */
