/**
 * Manifest Settings Validation
 *
 * This module deals with reading the manifest settings from a form: the
 * three a repository sets (`manifestRights`, `attributionEn`,
 * `attributionEs`) and the five a tenant sets (`publicSiteUrl`,
 * `publicSiteName`, `providerName`, `providerUrl`, `metsBaseUrl`). A
 * pipeline manifest takes its rights and attribution from the volume's
 * repository and its homepage, provider and METS link from the tenant,
 * so these values end up in published manifests as given.
 *
 * `readManifestFields` reads the named fields from a `FormData`, trims
 * each, and turns an empty value into null, so saving an empty field
 * clears it. The rights URI and the three URLs must be `http` or
 * `https` URIs when set; any other value is refused under its own field
 * name, with the message the repository form already gives a hero image
 * URL with another scheme. Trailing slashes are stripped from
 * `publicSiteUrl` and `metsBaseUrl`, because the manifest builder joins
 * a path onto each with a slash of its own. `providerUrl` and
 * `manifestRights` are kept as given: a provider id and a rights URI are
 * identifiers, and a trailing slash is part of them.
 *
 * `isHttpUri` is the URI check on its own; the seeding command uses it
 * on the values it plans to write.
 *
 * @version v0.8.0
 */

export const REPOSITORY_MANIFEST_FIELDS = [
  "manifestRights",
  "attributionEn",
  "attributionEs",
] as const;

export const TENANT_MANIFEST_FIELDS = [
  "publicSiteUrl",
  "publicSiteName",
  "providerName",
  "providerUrl",
  "metsBaseUrl",
] as const;

export type RepositoryManifestField = (typeof REPOSITORY_MANIFEST_FIELDS)[number];
export type TenantManifestField = (typeof TENANT_MANIFEST_FIELDS)[number];
type ManifestField = RepositoryManifestField | TenantManifestField;

const URI_FIELDS: ReadonlySet<ManifestField> = new Set([
  "manifestRights",
  "publicSiteUrl",
  "providerUrl",
  "metsBaseUrl",
]);

const TRAILING_SLASH_STRIPPED: ReadonlySet<ManifestField> = new Set([
  "publicSiteUrl",
  "metsBaseUrl",
]);

export const URI_SCHEME_MESSAGE = "URL must use http or https protocol";

/** Whether `value` parses as an absolute `http:` or `https:` URI. */
export function isHttpUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** On refusal, `errors` holds a message list under each refused field's name. */
export type ManifestFieldsResult<F extends ManifestField> =
  | { ok: true; values: Record<F, string | null> }
  | { ok: false; errors: Record<string, string[]> };

export function readManifestFields<F extends ManifestField>(
  formData: FormData,
  fields: readonly F[],
): ManifestFieldsResult<F> {
  const values = {} as Record<F, string | null>;
  const errors: Record<string, string[]> = {};
  for (const field of fields) {
    const raw = formData.get(field);
    let value = typeof raw === "string" ? raw.trim() : "";
    if (value !== "" && TRAILING_SLASH_STRIPPED.has(field)) value = value.replace(/\/+$/, "");
    if (value === "") {
      values[field] = null;
      continue;
    }
    if (URI_FIELDS.has(field) && !isHttpUri(value)) {
      errors[field] = [URI_SCHEME_MESSAGE];
      continue;
    }
    values[field] = value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values };
}

// @version v0.8.0
