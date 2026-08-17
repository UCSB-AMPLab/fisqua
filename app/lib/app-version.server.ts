/**
 * App Version
 *
 * This module deals with deriving a display version string from
 * `package.json`'s `version` field -- the single source of truth for
 * "what release is this" across the app. It exists because the landing
 * page's version badge used to be a plain locale string
 * (`hero.eyebrow: "FISQUA · v0.4"`) that had to be hand-bumped in both
 * `app/locales/en/landing.ts` and `app/locales/es/landing.ts` at every
 * release, and was not: it sat at "v0.4" through the 0.5 and 0.6
 * releases. Reading it from `package.json` instead means the badge can
 * never drift from the version that was actually shipped.
 *
 * Server-only (`.server.ts`) so the full `package.json` (author email,
 * scripts, dependency list) never enters the client bundle -- only the
 * derived `APP_VERSION` string, threaded through a route loader, does.
 *
 * @version v0.6.0
 */
import packageJson from "../../package.json";

/**
 * "0.6.0" -> "0.6". The badge has only ever shown major.minor (the
 * locked copy was "FISQUA · v0.4", never "v0.4.0") -- a patch number
 * would be release-tooling noise on a marketing surface that doesn't
 * track patch releases.
 */
export const APP_VERSION = packageJson.version.split(".").slice(0, 2).join(".");

// @version v0.6.0
