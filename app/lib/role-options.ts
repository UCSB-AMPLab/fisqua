/**
 * Role picker options
 *
 * This module deals with turning one federation's role lists, as
 * `readRoleVocabulary` (`vocabulary.server.ts`) returns them, into the
 * option groups the role `<select>`s render and the code-to-label maps
 * the pages show. Fisqua names no role, group or label of its own: a
 * picker offers exactly the federation's approved codes, and every
 * label is the federation's.
 *
 * `rolePickers` builds, in one language:
 *
 *   - `entityGroups`: one group per held role group, in the lists'
 *     order, labelled with the group's label; the codes whose group the
 *     federation does not hold form a last group whose key is null and
 *     whose label is empty, which a picker renders without a heading;
 *   - `placeOptions`: the approved place roles, flat, in position order;
 *   - `labels`: a map from code to label for every row of the entity,
 *     place and relation lists, whatever its status, so a code held by a
 *     link shows its label even when the list does not offer it.
 *
 * A label missing in the chosen language falls back to the other
 * language, then to the code. A code missing from a map shows the code
 * itself (`entityRoleLabel`, `placeRoleLabel`). A relation side takes
 * its label from the relation roles before the document roles, and any
 * other link the other way round, so a code held in both lists (such as
 * a spouse) reads as the list the link belongs to.
 *
 * An edit offers the link's current code even when the list does not
 * (`withCurrentGroup`, `withCurrentOption`), so opening an edit and
 * saving it keeps the code the link holds.
 *
 * `roleCode` reads a role code as every reader of a submitted or
 * proposed role must: trimmed, then matched exactly against the lists.
 *
 * The result holds only strings and arrays, so a loader passes it to
 * the page as it is. `NO_ROLE_PICKERS` is the value for a page that has
 * none.
 *
 * @version v0.9.0
 */
import type { RoleList, RoleVocabulary, VocabularyLabel } from "./vocabulary.server";

export type RoleLanguage = "es" | "en";

export interface RoleOption {
  value: string;
  label: string;
}

export interface RoleOptionGroup {
  /** A `role_group` code, or null for the codes with no held group. */
  key: string | null;
  label: string;
  options: RoleOption[];
}

export interface RoleLabels {
  entity: Record<string, string>;
  place: Record<string, string>;
  relation: Record<string, string>;
}

export interface RolePickers {
  entityGroups: RoleOptionGroup[];
  placeOptions: RoleOption[];
  labels: RoleLabels;
}

export const NO_ROLE_PICKERS: RolePickers = {
  entityGroups: [],
  placeOptions: [],
  labels: { entity: {}, place: {}, relation: {} },
};

function labelIn(label: VocabularyLabel | undefined, code: string, lang: RoleLanguage): string {
  const other: RoleLanguage = lang === "es" ? "en" : "es";
  return label?.[lang] || label?.[other] || code;
}

function labelMap(list: RoleList, lang: RoleLanguage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, label] of Object.entries(list.labels)) out[code] = labelIn(label, code, lang);
  return out;
}

/** The option groups and label maps of one federation's role lists, in one language. */
export function rolePickers(v: RoleVocabulary, lang: RoleLanguage): RolePickers {
  const entity = labelMap(v.entityRoles, lang);
  const place = labelMap(v.placeRoles, lang);
  return {
    entityGroups: v.entityRoles.groups.map((g) => ({
      key: g.code,
      label: g.code === null ? "" : labelIn(v.roleGroups.labels[g.code], g.code, lang),
      options: g.roles.map((code) => ({ value: code, label: entity[code] ?? code })),
    })),
    placeOptions: v.placeRoles.approved.map((code) => ({ value: code, label: place[code] ?? code })),
    labels: { entity, place, relation: labelMap(v.relationRoles, lang) },
  };
}

/** A submitted or proposed role code, trimmed; empty when there is none. */
export function roleCode(raw: string | null | undefined): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** The entity-role options, flat, in the groups' order. */
export function entityRoleOptions(p: RolePickers): RoleOption[] {
  return p.entityGroups.flatMap((g) => g.options);
}

/** The label of a person's or body's role; a relation side reads the relation roles first. */
export function entityRoleLabel(labels: RoleLabels, code: string, relationSide = false): string {
  return relationSide
    ? labels.relation[code] ?? labels.entity[code] ?? code
    : labels.entity[code] ?? labels.relation[code] ?? code;
}

/** The label of a place's role. */
export function placeRoleLabel(labels: RoleLabels, code: string): string {
  return labels.place[code] ?? code;
}

/** The groups, with the current code ahead of them when no group offers it. */
export function withCurrentGroup(groups: RoleOptionGroup[], code: string, label: string): RoleOptionGroup[] {
  if (!code || groups.some((g) => g.options.some((o) => o.value === code))) return groups;
  return [{ key: null, label: "", options: [{ value: code, label }] }, ...groups];
}

/** The options, with the current code ahead of them when they do not offer it. */
export function withCurrentOption(options: RoleOption[], code: string, label: string): RoleOption[] {
  if (!code || options.some((o) => o.value === code)) return options;
  return [{ value: code, label }, ...options];
}

// @version v0.9.0
