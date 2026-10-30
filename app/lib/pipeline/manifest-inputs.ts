/**
 * Media Pipeline — Manifest Inputs
 *
 * This module deals with the descriptive part of a pipeline manifest:
 * the `manifest` block of each volume entry in the run spec, which the
 * runner copies into the manifest it builds and which publishing checks
 * the held manifest against. Every value comes from a row Fisqua already
 * holds: the description, its repository and the tenant. Nothing here
 * names an archive, a corpus or a site.
 *
 * `manifestResolver(baseUrl)` returns the resolver dispatch uses. For a
 * volume, its description, the description's repository and the tenant,
 * it builds:
 *
 *   - `id`: `{baseUrl}/iiif/{reference_code}/manifest.json`, the volume's
 *     reference code under the tenant's manifest address (`manifestUrl`;
 *     dispatch passes `{manifest_base_url}/{slug}`, the federation's
 *     manifest address and the tenant's slug). Publishing's locator takes
 *     the same address and slug, so the id and the canonical key follow
 *     one rule;
 *   - `label`: the description's title, in Spanish;
 *   - `homepage`: the description's page on the tenant's public site,
 *     left out when the tenant has no `publicSiteUrl`;
 *   - `rights`: the repository's `manifestRights`. A repository without
 *     it is refused with `repository_rights_unset`;
 *   - `required_statement`: the repository's English and Spanish
 *     attribution under the label "Attribution" / "Atribución"; null
 *     when both are empty, refused with
 *     `repository_attribution_incomplete` when only one is set;
 *   - `provider`: one Agent from the tenant's `providerName` and
 *     `providerUrl`, with the public site as its homepage when the
 *     tenant has both `publicSiteUrl` and `publicSiteName`; an empty
 *     list when the tenant has no provider;
 *   - `metadata` (`manifestMetadata`): Date, Extent, Language, Access
 *     conditions, Reference and Repository, in that order, each with an
 *     English and Spanish label and a Spanish value; an empty value is
 *     left out, a value holding `|` becomes several values, and the
 *     language codes the catalogue migrated with read as "Español". The
 *     date is `date_expression` as stored. Repository is the
 *     repository's name followed by its city when it has one;
 *   - `summary`: the description's scope and content, when set;
 *   - `see_also`: the description's METS file under the tenant's
 *     `metsBaseUrl`, with `?` and `#` removed from the reference code,
 *     left out when the tenant has none.
 *
 * Field order inside each object follows the manifests already
 * published, so a field serialises to the same bytes. Values are kept as
 * given: trailing slashes are stripped from `publicSiteUrl` and
 * `metsBaseUrl` when they are saved, and again here, since the builder
 * adds its own.
 *
 * A refusal is a `ManifestInputsError` carrying its code and the
 * repository it concerns; dispatch turns it into a refusal of the run.
 *
 * @version v0.8.0
 */

import type { descriptions, repositories, tenants } from "../../db/schema";
import { manifestObjectPath } from "../promote/manifest-builder";
import { ManifestInputsError, type ManifestResolver, type RunSpecManifest } from "./run-spec";

/**
 * The manifests host Neogranadina's published manifests sit under. Only
 * the read-only comparison with those manifests uses it; a pipeline
 * manifest id is built under its tenant's own `manifest_base_url`.
 */
export const DEFAULT_MANIFEST_BASE_URL = "https://manifests.zasqua.org";

export type ManifestDescription = Pick<
  typeof descriptions.$inferSelect,
  | "referenceCode"
  | "title"
  | "dateExpression"
  | "extent"
  | "language"
  | "accessConditions"
  | "scopeContent"
>;

export type ManifestRepository = Pick<
  typeof repositories.$inferSelect,
  "id" | "code" | "name" | "city" | "manifestRights" | "attributionEn" | "attributionEs"
>;

export type ManifestTenant = Pick<
  typeof tenants.$inferSelect,
  "publicSiteUrl" | "publicSiteName" | "providerName" | "providerUrl" | "metsBaseUrl"
>;

export interface ManifestMetadataEntry {
  label: { en: string[]; es: string[] };
  value: { es: string[] };
}

export function manifestUrl(baseUrl: string, referenceCode: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${manifestObjectPath(referenceCode)}`;
}

// The language codes the catalogue was migrated with, read as Spanish.
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  "192": "Español",
  "173": "Español",
  "195": "Español",
  Spanish: "Español",
};

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The repository as a manifest names it: its name, then its city when set. */
export function repositoryDisplay(repository: Pick<ManifestRepository, "name" | "city">): string {
  return nonEmpty(repository.city) ? `${repository.name}, ${repository.city}` : repository.name;
}

export function manifestMetadata(
  description: ManifestDescription,
  repository: Pick<ManifestRepository, "name" | "city">,
): ManifestMetadataEntry[] {
  const language = nonEmpty(description.language)
    ? (LANGUAGE_NAMES[description.language] ?? description.language)
    : description.language;
  const pairs: Array<[string, string, string | null | undefined]> = [
    ["Date", "Fecha", description.dateExpression],
    ["Extent", "Extensión", description.extent],
    ["Language", "Idioma", language],
    ["Access conditions", "Condiciones de acceso", description.accessConditions],
    ["Reference", "Signatura", description.referenceCode],
    ["Repository", "Repositorio", repositoryDisplay(repository)],
  ];
  const out: ManifestMetadataEntry[] = [];
  for (const [en, es, value] of pairs) {
    if (!nonEmpty(value)) continue;
    const values = value.includes("|") ? value.split("|").map((v) => v.trim()) : [value];
    out.push({ label: { en: [en], es: [es] }, value: { es: values } });
  }
  return out;
}

function requiredStatement(repository: ManifestRepository): RunSpecManifest["required_statement"] {
  const en = repository.attributionEn;
  const es = repository.attributionEs;
  if (!nonEmpty(en) && !nonEmpty(es)) return null;
  if (!nonEmpty(en) || !nonEmpty(es)) {
    throw new ManifestInputsError(
      `Repository ${repository.code} has an attribution in one language only`,
      "repository_attribution_incomplete",
      { repository_id: repository.id, repository_code: repository.code },
    );
  }
  return {
    label: { en: ["Attribution"], es: ["Atribución"] },
    value: { en: [en], es: [es] },
  };
}

function provider(tenant: ManifestTenant): unknown[] {
  if (!nonEmpty(tenant.providerName) || !nonEmpty(tenant.providerUrl)) return [];
  const agent: Record<string, unknown> = {
    id: tenant.providerUrl,
    type: "Agent",
    label: { en: [tenant.providerName], es: [tenant.providerName] },
  };
  if (nonEmpty(tenant.publicSiteUrl) && nonEmpty(tenant.publicSiteName)) {
    agent.homepage = [
      {
        id: `${trimSlashes(tenant.publicSiteUrl)}/`,
        type: "Text",
        label: { en: [tenant.publicSiteName], es: [tenant.publicSiteName] },
        format: "text/html",
      },
    ];
  }
  return [agent];
}

/**
 * The manifest block for one volume. `referenceCode` is the volume's,
 * which names the manifest's key; the description supplies everything
 * else.
 */
export function resolveManifestInputs(
  baseUrl: string,
  referenceCode: string,
  description: ManifestDescription,
  repository: ManifestRepository,
  tenant: ManifestTenant,
): RunSpecManifest {
  if (!nonEmpty(repository.manifestRights)) {
    throw new ManifestInputsError(
      `Repository ${repository.code} has no manifest rights`,
      "repository_rights_unset",
      { repository_id: repository.id, repository_code: repository.code },
    );
  }
  const statement = requiredStatement(repository);
  const title = description.title;

  const manifest: RunSpecManifest = {
    id: manifestUrl(baseUrl, referenceCode),
    label: { es: [title] },
    rights: repository.manifestRights,
    required_statement: statement,
    provider: provider(tenant),
  };
  if (nonEmpty(tenant.publicSiteUrl)) {
    manifest.homepage = [
      {
        id: `${trimSlashes(tenant.publicSiteUrl)}/${description.referenceCode}/`,
        type: "Text",
        label: { es: [title] },
        format: "text/html",
      },
    ];
  }
  manifest.metadata = manifestMetadata(description, repository);
  if (nonEmpty(description.scopeContent)) {
    manifest.summary = { es: [description.scopeContent] };
  }
  if (nonEmpty(tenant.metsBaseUrl)) {
    const slug = description.referenceCode.replace(/[?#]/g, "");
    manifest.see_also = [
      {
        id: `${trimSlashes(tenant.metsBaseUrl)}/${slug}.xml`,
        type: "Dataset",
        label: { en: ["METS metadata"], es: ["Metadatos METS"] },
        format: "application/xml",
        profile: "http://www.loc.gov/METS/",
      },
    ];
  }
  return manifest;
}

/** The resolver dispatch uses, with ids under `baseUrl`. */
export function manifestResolver(baseUrl: string): ManifestResolver {
  return (volume, description, repository, tenant) => {
    if (description === null || repository === null) {
      throw new ManifestInputsError(
        `Volume ${volume.id} has no description or repository to build its manifest from`,
      );
    }
    return resolveManifestInputs(baseUrl, volume.referenceCode, description, repository, tenant);
  };
}

// @version v0.8.0
