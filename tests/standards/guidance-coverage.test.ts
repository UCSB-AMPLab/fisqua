/**
 * Tests — field guidance is never half-present, and never re-attributed
 *
 * A field's guidance has two halves that live apart on purpose: the
 * element number sits in `FieldConfig.guidance` (it is data about the
 * standard), and the quoted text sits in the locale bundles under
 * `guidance.<standard>.<column>` (it is translated). This suite is what
 * stops them drifting.
 *
 * ## The failure it exists to prevent
 *
 * A citation without text renders nothing — merely dead config. The
 * dangerous direction is the other one: text reachable under a standard
 * whose config never declared it, or text present in one language and
 * not the other. Both would put the standard's authority behind words
 * the standard did not supply, or show an English quotation to a
 * Spanish cataloguer. Guidance is quoted material presented as a
 * standard's own statement, so a wrong or missing attribution is not a
 * cosmetic bug — it is us misreporting what ISAD(G) says.
 *
 * Cross-standard fallback is deliberately absent from the lookup (see
 * `FieldConfig.guidance`), and the third test here pins that: no
 * standard may borrow another's wording, because a DACS tenant reading
 * ISAD(G)'s sentence under a DACS citation has been told something
 * false.
 *
 * @version v0.7.0
 */

import { describe, it, expect } from "vitest";
import { ISADG_CONFIG } from "../../app/lib/standards/isadg";
import { DACS_CONFIG } from "../../app/lib/standards/dacs";
import { RAD_CONFIG } from "../../app/lib/standards/rad";
import en from "../../app/locales/en/descriptions";
import es from "../../app/locales/es/descriptions";
import type { StandardConfig } from "../../app/lib/standards/types";

const CONFIGS: ReadonlyArray<StandardConfig> = [
  ISADG_CONFIG,
  DACS_CONFIG,
  RAD_CONFIG,
];

const BUNDLES: ReadonlyArray<{ lang: string; bundle: any }> = [
  { lang: "en", bundle: en },
  { lang: "es", bundle: es },
];

/** Columns in a config that declare an element citation. */
function citedColumns(config: StandardConfig): string[] {
  const cited: string[] = [];
  for (const section of config.sections) {
    for (const field of section.fields) {
      if (field.guidance) cited.push(field.column);
    }
  }
  return cited;
}

/**
 * Columns a locale bundle carries guidance text for, under one
 * standard. Keys are flat `"<column>.<standard>"` literals — the house
 * override convention, and the shape the no-hardcoded-standards guard
 * permits (its lookbehind exempts a standard name that follows a dot).
 */
function textColumns(bundle: any, standard: string): string[] {
  const suffix = `.${standard}`;
  return Object.keys(bundle?.guidance ?? {})
    .filter((k) => k.endsWith(suffix))
    .map((k) => k.slice(0, -suffix.length));
}

/** Every guidance string a bundle holds for one standard. */
function textValues(bundle: any, standard: string): Array<[string, string]> {
  return textColumns(bundle, standard).map((column) => [
    column,
    String(bundle.guidance[`${column}.${standard}`]),
  ]);
}

describe("field guidance — citation and quoted text stay in lockstep", () => {
  for (const config of CONFIGS) {
    const cited = citedColumns(config);

    for (const { lang, bundle } of BUNDLES) {
      it(`${config.standard}/${lang}: every cited column has quoted text`, () => {
        const have = new Set(textColumns(bundle, config.standard));
        const missing = cited.filter((c) => !have.has(c));
        expect(
          missing,
          `${config.standard} cites an element for ${missing.join(", ")} but the ` +
            `${lang} bundle has no text under guidance["<column>.${config.standard}"]. ` +
            `The affordance would render nothing; either add the quotation or ` +
            `drop the citation from app/lib/standards/${config.standard}.ts.`,
        ).toEqual([]);
      });

      it(`${config.standard}/${lang}: no quoted text without a citation`, () => {
        const citedSet = new Set(cited);
        const orphans = textColumns(bundle, config.standard).filter(
          (c) => !citedSet.has(c),
        );
        expect(
          orphans,
          `The ${lang} bundle carries ${config.standard} guidance for ` +
            `${orphans.join(", ")}, but the config declares no element for those ` +
            `columns — the quotation would have nothing to attribute itself to.`,
        ).toEqual([]);
      });
    }

    it(`${config.standard}: EN and ES cover exactly the same columns`, () => {
      const enCols = textColumns(en, config.standard).sort();
      const esCols = textColumns(es, config.standard).sort();
      expect(
        esCols,
        `A cataloguer working in Spanish would see an English quotation, or ` +
          `no quotation where an English session shows one.`,
      ).toEqual(enCols);
    });
  }

  for (const config of CONFIGS) {
    it(`${config.standard}: no example without a purpose statement`, () => {
      // An example on its own would render a bare "e.g. 103.5 cubic
      // feet" under a citation, with nothing saying what the element
      // is — an illustration of a rule the reader was never given.
      const orphans: string[] = [];
      for (const { lang, bundle } of BUNDLES) {
        const suffix = `.${config.standard}`;
        const withText = new Set(textColumns(bundle, config.standard));
        for (const key of Object.keys(bundle?.guidance_example ?? {})) {
          if (!key.endsWith(suffix)) continue;
          const column = key.slice(0, -suffix.length);
          if (!withText.has(column)) orphans.push(`${lang}: ${key}`);
        }
      }
      expect(orphans, orphans.join("\n")).toEqual([]);
    });

    it(`${config.standard}: examples cover the same columns in EN and ES`, () => {
      const cols = (bundle: any) =>
        Object.keys(bundle?.guidance_example ?? {})
          .filter((k) => k.endsWith(`.${config.standard}`))
          .sort();
      expect(
        cols(es),
        `An example shown in one language and not the other reads as a ` +
          `missing translation.`,
      ).toEqual(cols(en));
    });
  }

  it("no two standards share a guidance string", () => {
    // The lookup has no cross-standard fallback, so identical text
    // across standards is not a fallback artefact — it means someone
    // copied one standard's sentence under another's citation.
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { lang, bundle } of BUNDLES) {
      for (const config of CONFIGS) {
        for (const [column, text] of textValues(bundle, config.standard)) {
          const key = `${lang}|${text}`;
          const prior = seen.get(key);
          if (prior && prior !== config.standard) {
            collisions.push(
              `${lang}: ${config.standard}.${column} repeats ${prior}'s wording`,
            );
          }
          seen.set(key, config.standard);
        }
      }
    }
    expect(collisions, collisions.join("\n")).toEqual([]);
  });

  it("every guidance string is a real sentence, not a placeholder", () => {
    // Cheap guard against a stub reaching production under a citation.
    const bad: string[] = [];
    for (const { lang, bundle } of BUNDLES) {
      for (const config of CONFIGS) {
        for (const [column, text] of textValues(bundle, config.standard)) {
          const s = text;
          if (s.trim().length < 20 || /^(TODO|TBD|\.\.\.)/i.test(s.trim())) {
            bad.push(`${lang}: ${config.standard}.${column} = ${JSON.stringify(s)}`);
          }
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
});

/* @version v0.7.0 */
