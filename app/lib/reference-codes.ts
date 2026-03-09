import type { Entry } from "./boundary-types";

/**
 * Generate a reference code segment for an entry at a given position and depth.
 * Top-level (depth 0): slash + zero-padded 4-digit (position + 1).
 * Nested (depth 1+): dot + zero-padded 2-digit (position + 1).
 */
export function generateRefCode(
  parentRefCode: string,
  position: number,
  depth: number
): string {
  if (depth === 0) {
    return `${parentRefCode}/${String(position + 1).padStart(4, "0")}`;
  }
  return `${parentRefCode}.${String(position + 1).padStart(2, "0")}`;
}

/**
 * Compute reference codes for all entries in a tree.
 * Returns a Map of entryId -> computed reference code.
 * Walks the tree depth-first, building ref codes from the volume reference code.
 */
export function computeAllRefCodes(
  entries: Entry[],
  volumeRefCode: string
): Map<string, string> {
  const result = new Map<string, string>();
  if (entries.length === 0) return result;

  // Group entries by parentId
  const childrenByParent = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const key = entry.parentId;
    if (!childrenByParent.has(key)) {
      childrenByParent.set(key, []);
    }
    childrenByParent.get(key)!.push(entry);
  }

  // Sort each group by position
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.position - b.position);
  }

  // Walk depth-first
  function walk(parentId: string | null, parentRef: string, depth: number) {
    const children = childrenByParent.get(parentId);
    if (!children) return;

    for (const child of children) {
      const refCode = generateRefCode(parentRef, child.position, depth);
      result.set(child.id, refCode);
      walk(child.id, refCode, depth + 1);
    }
  }

  walk(null, volumeRefCode, 0);
  return result;
}
