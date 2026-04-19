/**
 * Description Level Helpers
 *
 * Pure helpers around the ISAD(G) description-level hierarchy: which
 * levels can parent which, display ordering, and i18n key resolution.
 *
 * @version v0.3.0
 */

import { DESCRIPTION_LEVELS } from "./validation/enums";

/**
 * Hierarchy ranking for description levels (ISAD(G)).
 * Lower number = higher in hierarchy.
 * Levels with the same rank are equivalent alternatives.
 */
export const LEVEL_HIERARCHY: Record<string, number> = {
  fonds: 0,
  subfonds: 1,
  collection: 1,
  series: 2,
  subseries: 3,
  section: 3,
  volume: 4,
  file: 4,
  item: 5,
};

/**
 * Returns the description levels allowed as children of a given parent level.
 * If no parent (root node), all levels are allowed.
 */
export function getAllowedChildLevels(parentLevel: string | null): string[] {
  if (!parentLevel) return [...DESCRIPTION_LEVELS];
  const parentRank = LEVEL_HIERARCHY[parentLevel] ?? 0;
  return DESCRIPTION_LEVELS.filter(
    (l) => (LEVEL_HIERARCHY[l] ?? 0) > parentRank
  );
}

/**
 * Checks whether a child level is valid under a given parent level.
 */
export function isValidChildLevel(
  parentLevel: string,
  childLevel: string
): boolean {
  return (LEVEL_HIERARCHY[childLevel] ?? 0) > (LEVEL_HIERARCHY[parentLevel] ?? 0);
}
