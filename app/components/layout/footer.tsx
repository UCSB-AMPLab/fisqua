/**
 * App Attribution — Version and Partner Logos
 *
 * This module holds the two quiet pieces of attribution the authenticated
 * app shows at the foot of the sidebar, in the same band as the button
 * that collapses it: the Fisqua version, linking to that release's notes
 * on GitHub, and the two partner logos (Neogranadina's seal and the AMP
 * Lab mark). `Sidebar` places them; this module only draws them, small
 * and muted, so they never compete with the navigation above.
 *
 * `VERSION` is the released version the link names. It is set by hand at
 * each release, alongside `package.json`, and the release's version sweep
 * looks for it here.
 *
 * @version v0.9.0
 */

export const VERSION = "0.9.0";

export function VersionLink() {
  return (
    <a
      href={`https://github.com/UCSB-AMPLab/fisqua/releases/tag/v${VERSION}`}
      className="whitespace-nowrap font-sans text-11 text-stone-400 hover:text-stone-600"
    >
      Fisqua v{VERSION}
    </a>
  );
}

export function PartnerLogos() {
  return (
    <div className="flex items-center gap-2">
      <img src="/brand/neogranadina-logo.svg" alt="Neogranadina" className="h-auto w-7 opacity-40" />
      <img src="/ampl-cropped-1.png" alt="AMP Lab, UC Santa Barbara" className="h-auto w-7 opacity-40" />
    </div>
  );
}

// @version v0.9.0
