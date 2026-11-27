/**
 * Vocabulary — reading a federation's role lists
 *
 * This module deals with reading the document and place roles of one
 * federation from `vocabulary_values`. Fisqua names no role, role group
 * or role label of its own: each federation keeps them in its
 * `entity_role`, `place_role` and `role_group` lists, and the pickers,
 * labels and validators read them from here. The `relation_role` list
 * is read beside them, because a relation side is a link whose role is
 * a relation role, and its label comes from that list.
 *
 * `readRoleVocabulary` reads the four lists in one statement, which the
 * unique index on `(federation_id, list, code)` serves, and sorts them in
 * memory. Each list comes back with the same four parts:
 *
 *   - `approved`: the approved codes, in order. Role groups and place
 *     roles follow their `position`; entity and relation roles follow
 *     their group's position, then their own position within the group,
 *     and the codes whose group the federation does not hold come last. Groups at one
 *     position are taken in code order, so each group's codes stay
 *     together. Other ties fall back to the code.
 *   - `deprecated`: the deprecated codes, in the same order. A link may
 *     keep one on an edit, but a new link may not take one.
 *   - `labels`: the Spanish and English label of every row of the list,
 *     whatever its status, so a code held by a link always has a label.
 *     A relation role's labels are its stored `label_es` and `label_en`,
 *     which hold the form for a person whose gender is not recorded.
 *   - `groups`: the approved codes by group, in group order, each code
 *     once; the codes with no held group form a last group whose code is
 *     null.
 *
 * Proposed codes are in neither `approved` nor `deprecated`: they are
 * offered nowhere.
 *
 * `readRolePickers` is what a page's loader calls: it runs
 * `readRoleVocabulary` once, retried while D1 refuses it as overloaded
 * (`retryD1Read`), and turns the lists into the option groups and the
 * code-to-label maps of `role-options.ts`, in the viewer's language. A
 * request that did not pass through the i18next middleware, such as a
 * loader called from a test, gets English.
 *
 * @version v0.9.0
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { RouterContextProvider } from "react-router";
import { vocabularyValues } from "../db/schema";
import { getLocale } from "../middleware/i18next";
import { retryD1Read } from "./d1-overload";
import { rolePickers, type RoleLanguage, type RolePickers } from "./role-options";

export const ROLE_LISTS = ["entity_role", "place_role", "role_group", "relation_role"] as const;

export interface VocabularyLabel {
  es: string | null;
  en: string | null;
}

export interface RoleListGroup {
  /** A `role_group` code, or null for the codes with no held group. */
  code: string | null;
  roles: string[];
}

export interface RoleList {
  approved: string[];
  deprecated: string[];
  labels: Record<string, VocabularyLabel>;
  groups: RoleListGroup[];
}

export interface RoleVocabulary {
  entityRoles: RoleList;
  placeRoles: RoleList;
  roleGroups: RoleList;
  relationRoles: RoleList;
}

interface Row {
  list: string;
  code: string;
  labelEs: string | null;
  labelEn: string | null;
  groupCode: string | null;
  position: number;
  status: string;
}

function listOf(rows: Row[], groupPosition: Map<string, number>): RoleList {
  // A code whose group is not held sorts after every held group. Groups at one position are
  // ordered by code, as the group list orders them, so each group's codes stay together.
  const held = (r: Row) => r.groupCode !== null && groupPosition.has(r.groupCode);
  const rank = (r: Row) => (held(r) ? groupPosition.get(r.groupCode!)! : Infinity);
  const groupOf = (r: Row) => (held(r) ? r.groupCode! : "");
  const byCode = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const sorted = [...rows].sort(
    (a, b) => rank(a) - rank(b) || byCode(groupOf(a), groupOf(b)) || a.position - b.position || byCode(a.code, b.code),
  );
  const approved = sorted.filter((r) => r.status === "approved");
  const labels: Record<string, VocabularyLabel> = {};
  for (const r of sorted) labels[r.code] = { es: r.labelEs, en: r.labelEn };

  const groups: RoleListGroup[] = [];
  for (const r of approved) {
    const code = r.groupCode !== null && groupPosition.has(r.groupCode) ? r.groupCode : null;
    const last = groups[groups.length - 1];
    if (last && last.code === code) last.roles.push(r.code);
    else groups.push({ code, roles: [r.code] });
  }
  return {
    approved: approved.map((r) => r.code),
    deprecated: sorted.filter((r) => r.status === "deprecated").map((r) => r.code),
    labels,
    groups,
  };
}

/** One federation's `entity_role`, `place_role`, `role_group` and `relation_role` lists, read in one statement. */
export async function readRoleVocabulary(db: DrizzleD1Database<any>, federationId: string): Promise<RoleVocabulary> {
  const rows: Row[] = await db
    .select({
      list: vocabularyValues.list,
      code: vocabularyValues.code,
      labelEs: vocabularyValues.labelEs,
      labelEn: vocabularyValues.labelEn,
      groupCode: vocabularyValues.groupCode,
      position: vocabularyValues.position,
      status: vocabularyValues.status,
    })
    .from(vocabularyValues)
    .where(and(eq(vocabularyValues.federationId, federationId), inArray(vocabularyValues.list, [...ROLE_LISTS])))
    .all();

  const of = (list: (typeof ROLE_LISTS)[number]) => rows.filter((r) => r.list === list);
  const groupRows = of("role_group");
  const groupPosition = new Map(groupRows.map((g) => [g.code, g.position]));
  // Role groups and place roles carry no group of their own, so they sort by position alone.
  return {
    entityRoles: listOf(of("entity_role"), groupPosition),
    placeRoles: listOf(of("place_role").map((r) => ({ ...r, groupCode: null })), new Map()),
    roleGroups: listOf(groupRows.map((r) => ({ ...r, groupCode: null })), new Map()),
    relationRoles: listOf(of("relation_role"), groupPosition),
  };
}

/** The viewer's language, or English when the request has none resolved. */
export function viewerRoleLanguage(context: Pick<RouterContextProvider, "get">): RoleLanguage {
  try {
    return getLocale(context as RouterContextProvider) === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

/** The role pickers and labels of one federation, in the viewer's language, for a page's loader. */
export async function readRolePickers(
  db: DrizzleD1Database<any>,
  federationId: string,
  context: Pick<RouterContextProvider, "get" | "set">,
): Promise<RolePickers> {
  const vocabulary = await retryD1Read(() => readRoleVocabulary(db, federationId), undefined, undefined, {
    read: "role_vocabulary",
    context,
  });
  return rolePickers(vocabulary, viewerRoleLanguage(context));
}

// @version v0.9.0
