/**
 * App Footer
 *
 * Thin footer strip shown at the bottom of the authenticated shell.
 * Surfaces the build version and a copyright line; deliberately
 * minimal so it never competes with the main content.
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
