/**
 * Institution records — external terms and authority sources
 *
 * This module holds the values
 * `scripts/commands/fill-institution-records.ts` seeds into every
 * federation's `vocabulary_values` and `authority_sources` beyond what the
 * code itself holds. The codes, groups and order come from
 * `app/lib/validation/enums.ts` and the labels from `app/locales/`, read
 * at run time; this file holds only what neither has.
 *
 * Place-type external terms: the three Getty AAT concepts the engine's
 * Linked Places script maps (`zasqua-engine-dev scripts/generate-places.js`
 * @ff90b6c, lines 121–123), stored as concept URIs. Every other place
 * type has none.
 *
 * Authority sources: the six production holds in every federation, in its
 * order. The URL templates are those the app builds its external links
 * from (`app/components/forms/lod-link-field.tsx` `SERVICE_URLS`), with
 * `{id}` where the identifier goes, except two: hgis has none, as HGIS
 * links are not shown on zasqua.org, and the template it replaces is
 * named; dbe has production's, as the app links no DBE identifier. The
 * labels are the field labels of the entity and place forms; `appliesTo`
 * is the record type whose form offers the field, or, for dbe, the
 * record type that holds the identifier.
 *
 * @version v0.9.0
 */

export interface ExternalTerm {
  scheme: "aat";
  uri: string;
  label: string;
  source: string;
}

const AAT_SOURCE = "zasqua-engine-dev scripts/generate-places.js @ff90b6c";

export const PLACE_TYPE_TERMS: Record<string, ExternalTerm> = {
  city: { scheme: "aat", uri: "http://vocab.getty.edu/aat/300008347", label: "inhabited places", source: `${AAT_SOURCE}:121` },
  river: { scheme: "aat", uri: "http://vocab.getty.edu/aat/300008707", label: "rivers", source: `${AAT_SOURCE}:122` },
  region: { scheme: "aat", uri: "http://vocab.getty.edu/aat/300182722", label: "regions (geographic)", source: `${AAT_SOURCE}:123` },
};

export interface AuthoritySourceSeed {
  key: string;
  /** The link template, with `{id}` where the identifier goes; null where no link is shown. */
  urlTemplate: string | null;
  templateSource: string;
  /** A held template the seed's replaces, written over only while held byte for byte, and where it came from. */
  replacesTemplate?: { value: string; source: string };
  /** Locale namespace file (under app/locales/{es,en}/) and key of the label. */
  labelFile: "entities" | "places";
  labelKey: string;
  appliesTo: Array<"entity" | "place">;
  appliesToSource: string;
}

const LOD = "app/components/forms/lod-link-field.tsx";

export const AUTHORITY_SOURCES: AuthoritySourceSeed[] = [
  {
    key: "wikidata",
    urlTemplate: "https://www.wikidata.org/wiki/{id}",
    templateSource: `${LOD}:37`,
    labelFile: "entities",
    labelKey: "field.wikidataId",
    appliesTo: ["entity"],
    appliesToSource: "app/routes/_auth.admin.entities.$id.tsx:1848 (places dropped wikidata_id in 0036)",
  },
  {
    key: "viaf",
    urlTemplate: "https://viaf.org/viaf/{id}",
    templateSource: `${LOD}:38`,
    labelFile: "entities",
    labelKey: "field.viafId",
    appliesTo: ["entity"],
    appliesToSource: "app/routes/_auth.admin.entities.$id.tsx:1855",
  },
  {
    key: "tgn",
    urlTemplate: "https://vocab.getty.edu/page/tgn/{id}",
    templateSource: `ruled 2026-11-15: TGN's readable page is /page/tgn (${LOD}:39)`,
    replacesTemplate: { value: "https://vocab.getty.edu/tgn/{id}", source: "the app's builder before the ruling and production D1 authority_sources.url_template of tgn, read 2026-11-14" },
    labelFile: "places",
    labelKey: "field.tgnId",
    appliesTo: ["place"],
    appliesToSource: "app/routes/_auth.admin.places.$id.tsx:1699",
  },
  {
    key: "hgis",
    urlTemplate: null,
    templateSource: "ruled 2026-11-14: HGIS links are not shown",
    replacesTemplate: { value: "https://hgis-indias.net/place/{id}", source: `${LOD}:40` },
    labelFile: "places",
    labelKey: "field.hgisId",
    appliesTo: ["place"],
    appliesToSource: "app/routes/_auth.admin.places.$id.tsx:1705",
  },
  {
    key: "whg",
    urlTemplate: "https://whgazetteer.org/places/{id}/detail",
    templateSource: `ruled 2026-11-15: WHG's record page is /detail (${LOD}:41)`,
    replacesTemplate: { value: "https://whgazetteer.org/places/{id}", source: "the app's builder before the ruling and production D1 authority_sources.url_template of whg, read 2026-11-14" },
    labelFile: "places",
    labelKey: "field.whgId",
    appliesTo: ["place"],
    appliesToSource: "app/routes/_auth.admin.places.$id.tsx:1711",
  },
  {
    key: "dbe",
    urlTemplate: "https://historia-hispanica.rah.es/biografias/{id}",
    templateSource:
      "production D1 authority_sources.url_template of dbe, read 2026-11-14 " +
      "(the app links no DBE identifier: app/routes/_auth.admin.entities.$id.tsx:1539 gives it no href)",
    labelFile: "entities",
    labelKey: "field.dbeId",
    appliesTo: ["entity"],
    appliesToSource: "app/db/schema.ts:1306 (entities.dbe_id), app/lib/validation/entity.ts:66",
  },
];

// @version v0.9.0
