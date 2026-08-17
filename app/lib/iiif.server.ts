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
 * deployment without recompiling. `parseManifest` and the URL
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
 * @version v0.7.0
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
export function getAllowedManifestHosts(env: {
  ALLOWED_MANIFEST_HOSTS?: string;
}): string[] {
  const raw = env.ALLOWED_MANIFEST_HOSTS?.trim();
  if (!raw) return DEFAULT_MANIFEST_HOSTS;
  return raw.split(",").map((h) => h.trim()).filter((h) => h.length > 0);
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
  env: { ALLOWED_MANIFEST_HOSTS?: string }
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
    const allowedHosts = getAllowedManifestHosts(env);
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
 *
 * Extracts:
 * - name from label language map (tries es, none, en in order)
 * - referenceCode from homepage[0].id URL
 * - pages from canvases with position, dimensions, and image service URL
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

  const manifest = (await response.json()) as any;

  // Extract label from v3 language map
  const label = manifest.label;
  const name =
    label?.es?.[0] || label?.none?.[0] || label?.en?.[0] || "Untitled";

  // Extract reference code from homepage URL
  const homepageUrl = manifest.homepage?.[0]?.id;
  if (!homepageUrl) {
    throw new ManifestError("manifest_ref_code");
  }

  const refMatch = homepageUrl.match(/zasqua\.org\/([^/]+)\/?$/);
  if (!refMatch) {
    throw new ManifestError("manifest_ref_code");
  }
  const referenceCode = refMatch[1];

  // Extract pages from canvases
  const canvases = manifest.items || [];
  const pages = canvases.map((canvas: any, index: number) => {
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

  return { name, referenceCode, manifestUrl, pageCount: pages.length, pages };
}
