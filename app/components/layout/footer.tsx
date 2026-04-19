/**
 * Application Footer
 *
 * A thin footer that lives below the sidebar-and-content layout on every
 * authenticated page except the full-page viewer and description editor.
 * It carries the release version (linked to the matching GitHub tag) plus
 * partner logos. The version string is kept as a module-level constant
 * and bumped in this same file every release so an audit of "what shipped
 * when" can skim the footer along with the package manifest.
 *
 * @version v0.3.0
 */

const VERSION = "0.3.0";

export function Footer() {
  return (
    <footer className="mt-auto border-t border-[#E7E5E4] px-4 py-4">
      <div className="mx-auto flex max-w-7xl items-center justify-between">
        <p className="text-xs text-stone-400">
          <a
            href={`https://github.com/neogranadina/zasqua-catalogacion/releases/tag/v${VERSION}`}
            className="text-stone-400 hover:text-stone-600"
          >
            Fisqua v{VERSION}
          </a>
        </p>
        <div className="flex items-center gap-3">
          <img
            src="/logo_grande.svg"
            alt="Neogranadina"
            className="h-6 opacity-40"
          />
          <img
            src="/ampl-cropped-1.png"
            alt="AMP Lab, UC Santa Barbara"
            className="h-6 opacity-40"
          />
        </div>
      </div>
    </footer>
  );
}
