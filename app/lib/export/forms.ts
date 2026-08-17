/**
 * Which column projection a form asks for
 *
 * This module deals with one question — given a chosen form and the
 * workspace's own standard, whose field set is being emitted? — and it
 * exists as its own file for a structural reason rather than a
 * conceptual one. Three emitters need the answer and the registry that
 * dispatches to them needs it too; if it lived in the registry, every
 * emitter would import the module that imports it, and a cycle between
 * a registry and its entries is the kind of thing that works until a
 * bundler reorders it.
 *
 * `emitters.server.ts` re-exports `standardForForm`, so callers that
 * already reach for it there keep working.
 *
 * @version v0.7.0
 */

import { isDescriptiveStandardForm } from "./matrix";
import type { ExportForm } from "./matrix";
import type { Standard } from "../standards/types";

/**
 * Which standard's column projection a form asks for. The three
 * descriptive standards name themselves; the canonical form defers to
 * the workspace's own standard, because "canonical" means the union
 * schema projected through the shape this workspace catalogues in.
 * Dublin Core names no standard at all — it is a fifteen-element
 * crosswalk with its own field set — so it has no answer here, and null
 * is how a caller learns to take the Dublin Core path.
 */
export function standardForForm(
  form: ExportForm,
  ownStandard: Standard,
): Standard | null {
  if (isDescriptiveStandardForm(form)) return form;
  if (form === "canonical") return ownStandard;
  return null;
}

/* @version v0.7.0 */
