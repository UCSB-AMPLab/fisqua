/**
 * Media Pipeline — Restriction Rule
 *
 * This module deals with one question: may a volume be sent to the
 * runner, or published? Restricted material is never tiled and never
 * published.
 *
 * Whether material is restricted is up to each archive, so it is not
 * worked out from the description. The description's access conditions
 * are free text and are not read for this. Each pipeline volume carries
 * an explicit true/false flag, `pipeline_volumes.restricted`, which is
 * false unless it is set for that volume.
 *
 * `isRestricted(volume)` reads that flag. It fails closed: when the
 * volume row could not be read, the volume counts as restricted.
 *
 * @version v0.8.0
 */

export function isRestricted(volume: { restricted: boolean } | null | undefined): boolean {
  return !volume || volume.restricted !== false;
}

// @version v0.8.0
