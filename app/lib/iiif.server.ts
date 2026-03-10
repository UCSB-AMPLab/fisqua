/**
 * IIIF Presentation API v3 manifest parsing and validation.
 *
 * Zasqua manifests follow a known v3 structure:
 * - label in {"es": [title]} format
 * - homepage with reference code in URL
 * - canvases with image services
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

const DEFAULT_MANIFEST_HOSTS = ["iiif.zasqua.org"];

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
 * Validates that a manifest URL is safe to fetch:
 * - Must use HTTPS
 * - Must be from an allowed host
 * - Must end with /manifest.json
 */
export function validateManifestUrl(
  url: string,
  env: { ALLOWED_MANIFEST_HOSTS?: string }
): {
  valid: boolean;
  error?: string;
} {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return { valid: false, error: "Manifest URL must use HTTPS" };
    }
    const allowedHosts = getAllowedManifestHosts(env);
    if (!allowedHosts.includes(parsed.hostname)) {
      return {
        valid: false,
        error: `Manifest must be from ${allowedHosts.join(" or ")}`,
      };
    }
    if (!parsed.pathname.endsWith("/manifest.json")) {
      return { valid: false, error: "URL must point to a manifest.json file" };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
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
    throw new Error(`Failed to fetch manifest: ${response.status}`);
  }

  const manifest = (await response.json()) as any;

  // Extract label from v3 language map
  const label = manifest.label;
  const name =
    label?.es?.[0] || label?.none?.[0] || label?.en?.[0] || "Untitled";

  // Extract reference code from homepage URL
  const homepageUrl = manifest.homepage?.[0]?.id;
  if (!homepageUrl) {
    throw new Error(
      "Cannot extract reference code: manifest is missing homepage field"
    );
  }

  const refMatch = homepageUrl.match(/zasqua\.org\/([^/]+)\/?$/);
  if (!refMatch) {
    throw new Error(
      "Cannot extract reference code: homepage URL does not match expected pattern"
    );
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
