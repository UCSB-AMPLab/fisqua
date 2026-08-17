/**
 * Documentation deep-links
 *
 * This module deals with the single source of truth for links from the
 * app into the public documentation site at docs.fisqua.org. Each topic
 * maps to a per-locale path — English under `/docs/…`, Spanish under
 * `/guia/…` — because the docs site localises its slugs, not just its
 * prose (e.g. `check` ↔ `verificacion`). A help affordance resolves a
 * topic against the reader's active language so the link lands on the
 * page in the language they are already using. Add a topic here and
 * every `DocsHelpLink` that names it stays in sync.
 *
 * @version v0.6.0
 */

/** Origin of the deployed documentation site. */
const DOCS_ORIGIN = "https://docs.fisqua.org";

/** A documentation topic the app can deep-link to. */
export type DocsTopic =
  | "importsUpload"
  | "importsProfile"
  | "importsCheck"
  | "importsDryRun"
  | "importsImport"
  | "importsRuns"
  | "importsRevert";

/**
 * Per-locale path for each topic. English and Spanish carry independent
 * paths because the docs site localises the slug as well as the text.
 */
const DOCS_PATHS: Record<DocsTopic, { en: string; es: string }> = {
  importsUpload: { en: "/docs/imports/upload/", es: "/guia/importaciones/carga/" },
  importsProfile: { en: "/docs/imports/profile/", es: "/guia/importaciones/perfil/" },
  importsCheck: { en: "/docs/imports/check/", es: "/guia/importaciones/verificacion/" },
  importsDryRun: { en: "/docs/imports/dry-run/", es: "/guia/importaciones/simulacion/" },
  importsImport: { en: "/docs/imports/import/", es: "/guia/importaciones/importacion/" },
  importsRuns: { en: "/docs/imports/runs/", es: "/guia/importaciones/ejecuciones/" },
  importsRevert: { en: "/docs/imports/revert/", es: "/guia/importaciones/reversion/" },
};

/**
 * Resolve a topic to its absolute documentation URL for `language`. Any
 * language other than English resolves to Spanish, matching the app's
 * `fallbackLanguage: "es"`.
 */
export function docsUrl(topic: DocsTopic, language: string): string {
  const paths = DOCS_PATHS[topic];
  const path = language.startsWith("en") ? paths.en : paths.es;
  return `${DOCS_ORIGIN}${path}`;
}
