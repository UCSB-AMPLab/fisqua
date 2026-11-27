/**
 * Relation as read — what the link forms saw of a link's relation
 *
 * This module deals with the part of a description link that the
 * description page's and the entity page's link forms read and send
 * back with an edit or a removal: the link it names in `related_to`,
 * and the links that name it. A relation side's partner can change
 * without changing the version of either entity (a merge's repoint
 * writes only the link), so the forms carry the relation as read and the
 * server compares it with the link as stored in the same statement that
 * writes (`relation-sides.server.ts`). It is shared by the pages, which
 * put it in the form, and the actions, which read it back.
 *
 * `relationAsReadFields` gives a link's two form fields:
 * `relatedToAsRead`, the id it names or blank, and `namedByAsRead`, the
 * ids of the links naming it, sorted and comma-separated, or blank.
 * `relationAsReadFrom` reads them from a submitted form; a form without
 * them (a request not made from these pages) gives null, and the action
 * then asks only that the link be outside every relation.
 * `isRelationSide` says whether a relation as read is one: the link names
 * another, or another names it.
 *
 * `RELATION_REFUSALS` lists the codes the actions answer with when they
 * refuse a link because of its relation; each has its message in the
 * pages' locale namespaces under `link_error_<code>`.
 *
 * @version v0.9.0
 */

/** A link's relation as a form read it: the link it names, and the links naming it, sorted. */
export interface RelationAsRead {
  relatedTo: string | null;
  namedBy: string[];
}

/** A link outside every relation. */
export const OUTSIDE_RELATIONS: RelationAsRead = { relatedTo: null, namedBy: [] };

/** The refusals the link forms' actions give because of a relation. */
export const RELATION_REFUSALS = [
  "relation_side_save",
  "relation_side_remove",
  "relation_changed_save",
  "relation_changed_remove",
] as const;

export type RelationRefusal = (typeof RELATION_REFUSALS)[number];

/** Whether an action's error code is one of the relation refusals. */
export function isRelationRefusal(code: unknown): code is RelationRefusal {
  return typeof code === "string" && (RELATION_REFUSALS as readonly string[]).includes(code);
}

/** Whether the relation as read makes the link a relation side: it names a link, or a link names it. */
export function isRelationSide(r: RelationAsRead): boolean {
  return r.relatedTo !== null || r.namedBy.length > 0;
}

/** The ids of the links naming a link, from the loader's comma-separated list, sorted. */
export function namedByList(joined: string | null | undefined): string[] {
  return (joined ?? "").split(",").map((s) => s.trim()).filter(Boolean).sort();
}

/** The form fields that carry a link's relation as read. */
export function relationAsReadFields(link: { relatedTo?: string | null; namedBy?: string[] }): Record<string, string> {
  return {
    relatedToAsRead: link.relatedTo ?? "",
    namedByAsRead: [...(link.namedBy ?? [])].sort().join(","),
  };
}

/** The relation as read from a submitted form, or null when the form carries none. */
export function relationAsReadFrom(form: FormData): RelationAsRead | null {
  const relatedTo = form.get("relatedToAsRead");
  const namedBy = form.get("namedByAsRead");
  if (typeof relatedTo !== "string" || typeof namedBy !== "string") return null;
  return { relatedTo: relatedTo.trim() === "" ? null : relatedTo.trim(), namedBy: namedByList(namedBy) };
}

/** Whether two relations as read are the same. */
export function sameRelation(a: RelationAsRead, b: RelationAsRead): boolean {
  return a.relatedTo === b.relatedTo && a.namedBy.length === b.namedBy.length && a.namedBy.every((id, i) => id === b.namedBy[i]);
}

// @version v0.9.0
