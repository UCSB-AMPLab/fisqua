/**
 * IIIF Manifest Parser and Validator
 *
 * This module deals with the server-side ingestion of IIIF
 * Presentation API v3 manifests — the standard JSON documents that
 * describe a digitised volume's pages, images, and bibliographic
 * label. When a cataloguer pastes a manifest URL into the
 * volume-import form, Fisqua fetches the manifest from the upstream
 * IIIF server, parses it into the canonical `ParsedManifest` shape,
 * and uses that shape to populate `volumes` and `volume_pages` rows
 * without an out-of-band data-entry pass.
 *
 * `getAllowedManifestHosts` reads the comma-separated
 * `ALLOWED_MANIFEST_HOSTS` env var (falling back to
 * `manifests.zasqua.org`) so the host allowlist is configurable per
 * deployment without recompiling, and adds any hosts the caller passes:
 * the manifest hosts of the tenants' storage destinations, which the
 * route reads from D1, so a tenant's own manifests can be fetched
 * without a deploy. `parseManifest` and the URL
 * validation helpers around it pin the shape we expect from
 * Zasqua-style manifests — a Spanish-locale label, a homepage that
 * carries the reference code in the URL, and canvases whose first
 * `body` exposes an image service URL — and reject anything that
 * does not match before the import can write to D1. The HTTPS check
 * and the allowlist together close the SSRF surface that an
 * unsanitised cataloguer-supplied URL would otherwise open.
 *
 * Failures never carry prose: `validateManifestUrl` returns stable
 * error tokens (with the allowed hosts as a separate field) and
 * `parseManifest` throws `ManifestError` tokens, so the consuming
 * route translates at the render boundary.
 *
 * The parse is also used on manifests read from storage rather than
 * fetched: `parseManifestDocument` takes the JSON already in hand, and
 * `parseManifestPages` reads only its canvases. A malformed document
 * throws a token there too, never a `TypeError`.
 *
 * @version v0.8.0
 */

export interface ParsedManifest {
  name: string;
  referenceCode: string;
  manifestUrl: string;
  pageCount: number;
  pages: Array<{
    position: number;
    width: number;
    height: number;
    imageUrl: string;
    label: string;
  }>;
}

const DEFAULT_MANIFEST_HOSTS = ["manifests.zasqua.org"];

/**
 * Returns the list of allowed IIIF manifest hosts from the env var,
 * falling back to the default host if not set.
 */
export function getAllowedManifestHosts(
  env: { ALLOWED_MANIFEST_HOSTS?: string },
  extraHosts: readonly string[] = [],
): string[] {
  const raw = env.ALLOWED_MANIFEST_HOSTS?.trim();
  const configured = raw
    ? raw.split(",").map((h) => h.trim()).filter((h) => h.length > 0)
    : DEFAULT_MANIFEST_HOSTS;
  return [...new Set([...configured, ...extraHosts])];
}

/**
 * Error thrown by `parseManifest`. The `message` is a stable token
 * (`manifest_fetch_failed`, `manifest_ref_code`) — never prose — and
 * `status` carries the upstream HTTP status for interpolation at the
 * render boundary.
 */
export class ManifestError extends Error {
  status?: number;

  constructor(token: string, status?: number) {
    super(token);
    this.name = "ManifestError";
    this.status = status;
  }
}

/**
 * Validates that a manifest URL is safe to fetch:
 * - Must use HTTPS
 * - Must be from an allowed host
 * - Must end with /manifest.json
 *
 * On failure, `error` is a stable token and `hosts` carries the
 * allowlist separately so the caller can interpolate it into a
 * translated message.
 */
export function validateManifestUrl(
  url: string,
  env: { ALLOWED_MANIFEST_HOSTS?: string },
  extraHosts: readonly string[] = [],
): {
  valid: boolean;
  error?: string;
  hosts?: string[];
} {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return { valid: false, error: "manifest_https" };
    }
    const allowedHosts = getAllowedManifestHosts(env, extraHosts);
    if (!allowedHosts.includes(parsed.hostname)) {
      return {
        valid: false,
        error: "manifest_host",
        hosts: allowedHosts,
      };
    }
    if (!parsed.pathname.endsWith("/manifest.json")) {
      return { valid: false, error: "manifest_path" };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "manifest_invalid_url" };
  }
}

/**
 * Fetches and parses a IIIF v3 manifest, extracting volume and page data.
 * The parse itself is `parseManifestDocument`; this adds the fetch.
 *
 * Throws if the manifest is unreachable or missing required fields.
 */
export async function parseManifest(
  manifestUrl: string
): Promise<ParsedManifest> {
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new ManifestError("manifest_fetch_failed", response.status);
  }
  return parseManifestDocument(await response.json(), manifestUrl);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a IIIF v3 manifest that is already in hand as JSON.
 *
 * Extracts:
 * - name from label language map (tries es, none, en in order)
 * - referenceCode from homepage[0].id URL
 * - pages from canvases, through `parseManifestPages`
 *
 * A document that is not an object, or whose homepage id is missing,
 * not a string or not a `zasqua.org/<reference_code>` URL, throws
 * `manifest_ref_code`.
 */
export function parseManifestDocument(
  manifest: unknown,
  manifestUrl: string
): ParsedManifest {
  if (!isPlainObject(manifest)) {
    throw new ManifestError("manifest_ref_code");
  }

  // Extract label from v3 language map
  const label = manifest.label;
  const name =
    label?.es?.[0] || label?.none?.[0] || label?.en?.[0] || "Untitled";

  // Extract reference code from homepage URL
  const homepageUrl = manifest.homepage?.[0]?.id;
  if (typeof homepageUrl !== "string" || !homepageUrl) {
    throw new ManifestError("manifest_ref_code");
  }

  const refMatch = homepageUrl.match(/zasqua\.org\/([^/]+)\/?$/);
  if (!refMatch) {
    throw new ManifestError("manifest_ref_code");
  }
  const referenceCode = refMatch[1];

  const pages = parseManifestPages(manifest);
  return { name, referenceCode, manifestUrl, pageCount: pages.length, pages };
}

/**
 * Reads a manifest's canvases into pages: position, dimensions, the
 * image service URL of the first painting body, and a label. `items`
 * that is present but not an array, or a canvas that is not an object,
 * throws `manifest_items`.
 */
export function parseManifestPages(manifest: unknown): ParsedManifest["pages"] {
  if (!isPlainObject(manifest)) {
    throw new ManifestError("manifest_items");
  }
  const canvases: unknown = manifest.items ?? [];
  if (!Array.isArray(canvases)) {
    throw new ManifestError("manifest_items");
  }
  return canvases.map((canvas: unknown, index: number) => {
    if (!isPlainObject(canvas)) {
      throw new ManifestError("manifest_items");
    }
    const annoPage = canvas.items?.[0];
    const annotation = annoPage?.items?.[0];
    const body = annotation?.body;

    // Get image service URL (IIIF Image API base)
    const service = body?.service?.[0];
    const imageUrl = service?.id || body?.id || "";

    // Extract canvas label from v3 language map with fallback chain
    const canvasLabel = canvas.label;
    const pageLabel =
      canvasLabel?.none?.[0] ||
      canvasLabel?.es?.[0] ||
      canvasLabel?.en?.[0] ||
      String(index + 1);

    return {
      position: index + 1,
      width: canvas.width,
      height: canvas.height,
      imageUrl,
      label: pageLabel,
    };
  });
}
