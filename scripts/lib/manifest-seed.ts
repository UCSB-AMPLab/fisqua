/**
 * Scripts — manifest settings seed values
 *
 * This module deals with the values the manifest-fields command plans to
 * write for the two seeded tenants, Neogranadina with its four
 * repositories and the Archivo Histórico de Rionegro (`ahr`) with its
 * one, so that a pipeline manifest for their volumes carries what their
 * published manifests carry now. The attribution templates for the four
 * Neogranadina repositories, the country names and the rights URI are
 * those of the retired catalogue's manifest generator, copied verbatim;
 * the tenant values are those its manifests publish (`provider`, the
 * provider's homepage, each manifest's homepage and its METS link).
 * The `co-ahr` template is not from the generator: it was set for
 * Rionegro, because the generator's default for codes it did not list
 * had no Neogranadina role in the wording.
 *
 * `NEOGRANADINA_MANIFEST_TENANT` is the five tenant values.
 * `AHR_MANIFEST_TENANT` is the same five: Rionegro is published on
 * zasqua.org and its METS files are served under the same address.
 * `SEEDED_MANIFEST_TENANTS` maps each seeded tenant id to its values.
 * `NEOGRANADINA_MANIFEST_RIGHTS` is the rights URI, Neogranadina's
 * policy for these repositories rather than a platform default, and
 * also the one for `co-ahr`.
 * `ATTRIBUTION_TEMPLATES` maps the five repository codes to their
 * English and Spanish templates; the generator had a fallback for any
 * other code, which is not carried here because no other repository is
 * seeded. `fillAttribution` fills a template with the repository's
 * display name (its name, then ", city" when it has one), its country
 * as stored (Spanish), and the English name of that country (Perú
 * becomes Peru; any other country stays as stored, as the generator
 * did). `seededRepositoryValues` returns the three repository values
 * for a row, or null for a code with no template.
 *
 * `REPOSITORY_RIGHTS_TEXT` maps the same five codes to the image
 * reproduction text zasqua.org shows for each repository today, copied
 * verbatim from the instance's `repositories.json`
 * (`image_reproduction_text`), which the retired catalogue exported from
 * its rights field. Fisqua exports `rights_text` under that name and
 * writes it into a digitised description's METS rights statement.
 *
 * @version v0.8.0
 */

import { AHR_TENANT_ID, NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";

export const NEOGRANADINA_MANIFEST_TENANT = {
  publicSiteUrl: "https://zasqua.org",
  publicSiteName: "Zasqua",
  providerName: "Neogranadina",
  providerUrl: "https://neogranadina.org/",
  metsBaseUrl: "https://manifests.zasqua.org/mets",
} as const;

export const AHR_MANIFEST_TENANT = { ...NEOGRANADINA_MANIFEST_TENANT } as const;

/** The tenants the command seeds, by tenant id. */
export const SEEDED_MANIFEST_TENANTS: Readonly<Record<string, typeof NEOGRANADINA_MANIFEST_TENANT>> = {
  [NEOGRANADINA_TENANT_ID]: NEOGRANADINA_MANIFEST_TENANT,
  [AHR_TENANT_ID]: AHR_MANIFEST_TENANT,
};

export const NEOGRANADINA_MANIFEST_RIGHTS = "http://creativecommons.org/licenses/by-nc/4.0/";

interface AttributionTemplate {
  en: string;
  es: string;
}

export const ATTRIBUTION_TEMPLATES: Readonly<Record<string, AttributionTemplate>> = {
  "co-cihjml": {
    en: "{repo}, {country_en}. Digitized by Neogranadina and hosted on Zasqua (zasqua.org).",
    es: "{repo}, {country}. Digitalizado por Neogranadina y alojado en Zasqua (zasqua.org).",
  },
  "co-ahrb": {
    en: "{repo}, {country_en}. Digitized by Neogranadina and hosted on Zasqua (zasqua.org).",
    es: "{repo}, {country}. Digitalizado por Neogranadina y alojado en Zasqua (zasqua.org).",
  },
  "co-ahr": {
    en: "{repo}, {country_en}. Digitized with Neogranadina and hosted on Zasqua (zasqua.org).",
    es: "{repo}, {country}. Digitalizado con Neogranadina y alojado en Zasqua (zasqua.org).",
  },
  "pe-bn": {
    en: "{repo}, {country_en}. Processed by Neogranadina and hosted on Zasqua (zasqua.org).",
    es: "{repo}, {country}. Procesado por Neogranadina y alojado en Zasqua (zasqua.org).",
  },
  "co-ahjci": {
    en:
      "{repo}, {country_en}. Digitized under the Endangered Archives Programme (EAP 1477), " +
      "funded by Arcadia and held at the British Library. CC BY-NC 4.0. " +
      "Processed by Neogranadina and hosted on Zasqua (zasqua.org).",
    es:
      "{repo}, {country}. Digitalizado en el marco del Endangered Archives Programme (EAP 1477), " +
      "financiado por Arcadia y custodiado en la British Library. CC BY-NC 4.0. " +
      "Procesado por Neogranadina y alojado en Zasqua (zasqua.org).",
  },
};

const COUNTRY_EN: Readonly<Record<string, string>> = {
  Colombia: "Colombia",
  "Perú": "Peru",
};

export interface SeedRepository {
  code: string;
  name: string;
  city: string | null;
  country: string | null;
}

export function fillAttribution(template: string, repository: SeedRepository): string {
  const repo = repository.city ? `${repository.name}, ${repository.city}` : repository.name;
  const country = repository.country ?? "";
  const countryEn = COUNTRY_EN[country] ?? country;
  return template
    .replaceAll("{repo}", repo)
    .replaceAll("{country_en}", countryEn)
    .replaceAll("{country}", country);
}

export function seededRepositoryValues(
  repository: SeedRepository,
): { manifestRights: string; attributionEn: string; attributionEs: string } | null {
  const template = ATTRIBUTION_TEMPLATES[repository.code];
  if (!template) return null;
  return {
    manifestRights: NEOGRANADINA_MANIFEST_RIGHTS,
    attributionEn: fillAttribution(template.en, repository),
    attributionEs: fillAttribution(template.es, repository),
  };
}

export const REPOSITORY_RIGHTS_TEXT: Readonly<Record<string, string>> = {
  "co-ahjci":
    "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al Archivo Histórico del Juzgado del Circuito de Istmina.",
  "co-ahr":
    "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al Archivo Histórico de Rionegro.",
  "co-ahrb":
    "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al Archivo Histórico Regional de Boyacá.",
  "co-cihjml":
    "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al CIHJML, Universidad del Cauca.",
  "pe-bn":
    "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase a la Biblioteca Nacional del Perú.",
};

// @version v0.8.0
