/**
 * The Attribution Line
 *
 * This module deals with the one attribution line every output carries
 * for a repository's digitized materials: the export's `attribution`
 * (`institution-records.server.ts`) and the IIIF `requiredStatement`
 * the media pipeline writes (`app/lib/pipeline/manifest-inputs.ts`).
 * Both import it, so the line cannot read one way in the export and
 * another in a manifest.
 *
 * `composeAttribution` builds the line per language from generic parts
 * only, each included when present:
 *
 *   "{name}, {city}, {region}, {country}." "{credit statement}"
 *   "{hosting statement}" "{licence label}."
 *
 * The place parts are joined with commas and the group is closed with a
 * full stop. The city and region are used as stored in both lines. Each
 * line names the country in its own language (`countryName`): the
 * repository's `country_code`, ISO 3166-1 alpha-2 or the alpha-3 shape
 * the repository forms store, is named by `Intl.DisplayNames` for that
 * language, so Perú reads Peru in English and United States reads Estados
 * Unidos in Spanish. The stored country is kept when the code is absent
 * or names no country, and a code never adds a country the repository
 * does not state. The credit statement is the repository's, the hosting
 * statement the federation's; each is used exactly as written, with no
 * punctuation added. The licence label is followed by a full stop and is
 * the same in both languages. Parts are separated by one space. The name
 * is not translated. A statement blank in one language is absent there:
 * the English line never borrows the Spanish statement, nor the other way
 * round. A federation without a hosting statement (null, or both columns
 * blank) gets the line without it.
 *
 * `repositoryAttribution` is what every output writes: the stored
 * override (`attribution_es`, `attribution_en`) where it is set, in its
 * own language only, else the composed line. A language with neither is
 * null.
 *
 * `licenceLabel` names the Creative Commons licences and public-domain
 * tools in its list, by their canonical URI, and gives any other URI no
 * label rather than guessing one. `text` reads null or whitespace-only
 * stored text as absent.
 *
 * It reads nothing itself and imports nothing from the server (only the
 * ISO 3166-1 table in `../countries`), so the export, the pipeline and
 * the scripts share it.
 *
 * @version v0.9.0
 */

import { countryByAlpha2, countryByAlpha3 } from "../countries";

/** A prose field in both languages; either may be null. */
export interface Bilingual {
  es: string | null;
  en: string | null;
}

/** The repository columns the line reads. */
export interface AttributionRepository {
  name: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  /** ISO 3166-1, alpha-2 or alpha-3; names the country in each line's language. */
  countryCode: string | null;
  manifestRights: string | null;
  creditStatementEs: string | null;
  creditStatementEn: string | null;
  attributionEs: string | null;
  attributionEn: string | null;
}

/** The federation columns the line reads. */
export interface FederationHosting {
  hostingStatementEs: string | null;
  hostingStatementEn: string | null;
}

/** Stored text, or null when it is null or only whitespace. */
export function text(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === "" ? null : value;
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/**
 * The licences whose labels are derived, by the path of their canonical
 * URI on creativecommons.org. A URI is in the domain when it is exactly
 * `http://` or `https://`, `creativecommons.org/`, one of these paths,
 * and an optional single trailing slash.
 */
const LICENCE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["licenses/by/4.0", "CC BY 4.0"],
  ["licenses/by-sa/4.0", "CC BY-SA 4.0"],
  ["licenses/by-nc/4.0", "CC BY-NC 4.0"],
  ["licenses/by-nc-sa/4.0", "CC BY-NC-SA 4.0"],
  ["licenses/by-nd/4.0", "CC BY-ND 4.0"],
  ["licenses/by-nc-nd/4.0", "CC BY-NC-ND 4.0"],
  ["publicdomain/zero/1.0", "CC0 1.0"],
  ["publicdomain/mark/1.0", "Public Domain Mark 1.0"],
];

/** Every accepted spelling of every listed URI, to its label. */
const LICENCE_BY_URI: ReadonlyMap<string, string> = new Map(
  LICENCE_LABELS.flatMap(([path, label]) =>
    ["http", "https"].flatMap((scheme) =>
      ["", "/"].map((slash) => [`${scheme}://creativecommons.org/${path}${slash}`, label] as const),
    ),
  ),
);

/** The label of a licence URI, the same in both languages; no label outside the list. */
export function licenceLabel(uri: string | null): Bilingual {
  const label = uri === null ? undefined : LICENCE_BY_URI.get(uri);
  return label === undefined ? { es: null, en: null } : { es: label, en: label };
}

// ---------------------------------------------------------------------------
// The country name
// ---------------------------------------------------------------------------

/** The region names per line language; a code with no name gives undefined. */
const REGIONS = {
  es: new Intl.DisplayNames(["es"], { type: "region", fallback: "none" }),
  en: new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }),
} as const;

/** The alpha-2 code of an assigned alpha-2 or alpha-3 code, or null. */
function alpha2(code: string | null): string | null {
  const key = text(code)?.trim().toUpperCase() ?? null;
  if (key === null) return null;
  if (/^[A-Z]{2}$/.test(key)) return countryByAlpha2(key)?.alpha2 ?? null;
  if (/^[A-Z]{3}$/.test(key)) return countryByAlpha3(key)?.alpha2 ?? null;
  return null;
}

/**
 * The country as one language's line names it: the name of the country
 * code in that language when the repository states a country and the
 * code names one, else the stored country.
 */
function countryName(locale: keyof typeof REGIONS, country: string | null, code: string | null): string | null {
  if (text(country) === null) return null;
  const key = alpha2(code);
  if (key === null) return country;
  try {
    return REGIONS[locale].of(key) ?? country;
  } catch {
    return country;
  }
}

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

/** One language's composed line, or null when it has no part at all. */
function composeLine(
  repo: AttributionRepository,
  country: string | null,
  credit: string | null,
  hosting: string | null,
  label: string | null,
): string | null {
  const place = [repo.name, repo.city, repo.region, country]
    .map((part) => text(part))
    .filter((part): part is string => part !== null);
  const parts = [
    place.length > 0 ? `${place.join(", ")}.` : null,
    text(credit),
    text(hosting),
    label === null ? null : `${label}.`,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * The attribution line composed from the repository's name, place and
 * credit statement, the federation's hosting statement and the image
 * licence label, in each language.
 */
export function composeAttribution(repo: AttributionRepository, hosting: FederationHosting | null): Bilingual {
  const label = licenceLabel(text(repo.manifestRights));
  return {
    es: composeLine(
      repo,
      countryName("es", repo.country, repo.countryCode),
      repo.creditStatementEs,
      hosting?.hostingStatementEs ?? null,
      label.es,
    ),
    en: composeLine(
      repo,
      countryName("en", repo.country, repo.countryCode),
      repo.creditStatementEn,
      hosting?.hostingStatementEn ?? null,
      label.en,
    ),
  };
}

/** The attribution every output writes: the stored override where set, per language, else the composed line. */
export function repositoryAttribution(repo: AttributionRepository, hosting: FederationHosting | null): Bilingual {
  const composed = composeAttribution(repo, hosting);
  return {
    es: text(repo.attributionEs) ?? composed.es,
    en: text(repo.attributionEn) ?? composed.en,
  };
}

// @version v0.9.0
