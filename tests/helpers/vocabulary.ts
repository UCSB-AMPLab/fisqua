/**
 * Tests — seeding a federation's role lists
 *
 * This helper writes rows of a federation's `entity_role`, `place_role`
 * and `role_group` lists into the test database's `vocabulary_values`,
 * so a suite can give each federation the lists it needs before it
 * reads them. `seedRoleLists` takes the rows as given: a list, a code,
 * the two labels, the group (entity roles only), the position and the
 * status, which is `approved` unless a row names another. Each row gets
 * a fresh id and the current clock. `roleSetRows` turns a role set of
 * `scripts/data/vocabularies/` into those rows, so a suite can give a
 * federation the Neogranadina set or the starter set. Call
 * `seedRoleLists` after `cleanDatabase()`, which clears
 * `vocabulary_values`.
 *
 * `roleSetPickers` gives the role pickers and labels a page's loader
 * would pass for a role set, in one language, without a database, for
 * a suite that renders a page from fixed loader data. Every row of the
 * set is approved, so the pickers offer the whole set, and the set has
 * no relation roles.
 *
 * @version v0.9.0
 */
import { env } from "cloudflare:test";
import type { RoleVocabularySet } from "../../scripts/data/vocabularies/neogranadina-roles";
import { rolePickers, type RoleLanguage, type RolePickers } from "../../app/lib/role-options";
import type { RoleList } from "../../app/lib/vocabulary.server";

export interface RoleListRow {
  list: "entity_role" | "place_role" | "role_group";
  code: string;
  es?: string | null;
  en?: string | null;
  group?: string | null;
  position: number;
  status?: "approved" | "proposed" | "deprecated";
}

/** The rows of a role set's groups, entity roles and place roles. */
export function roleSetRows(set: RoleVocabularySet): RoleListRow[] {
  return [
    ...set.groups.map((g) => ({ list: "role_group" as const, code: g.code, es: g.es, en: g.en, position: g.position })),
    ...set.entityRoles.map((r) => ({ list: "entity_role" as const, code: r.code, es: r.es, en: r.en, group: r.group, position: r.position })),
    ...set.placeRoles.map((r) => ({ list: "place_role" as const, code: r.code, es: r.es, en: r.en, position: r.position })),
  ];
}

/** Inserts the rows into the federation's lists, in one batch. */
export async function seedRoleLists(federationId: string, rows: RoleListRow[]): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  const insert = env.DB.prepare(
    "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, group_code, position, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  await env.DB.batch(
    rows.map((r) =>
      insert.bind(
        crypto.randomUUID(),
        federationId,
        r.list,
        r.code,
        r.es ?? null,
        r.en ?? null,
        r.group ?? null,
        r.position,
        r.status ?? "approved",
        now,
        now,
      ),
    ),
  );
}

/** The pickers and labels a loader passes for a role set, in one language. */
export function roleSetPickers(set: RoleVocabularySet, lang: RoleLanguage): RolePickers {
  const groups = [...set.groups].sort((a, b) => a.position - b.position);
  const groupRank = new Map(groups.map((g, i) => [g.code, i]));
  const entity = [...set.entityRoles].sort(
    (a, b) => (groupRank.get(a.group) ?? Infinity) - (groupRank.get(b.group) ?? Infinity) || a.position - b.position,
  );
  const place = [...set.placeRoles].sort((a, b) => a.position - b.position);
  const list = (rows: Array<{ code: string; es: string; en: string }>, grouped: RoleList["groups"]): RoleList => ({
    approved: rows.map((r) => r.code),
    deprecated: [],
    labels: Object.fromEntries(rows.map((r) => [r.code, { es: r.es, en: r.en }])),
    groups: grouped,
  });
  const entityGroups = groups
    .map((g) => ({ code: g.code as string | null, roles: entity.filter((r) => r.group === g.code).map((r) => r.code) }))
    .filter((g) => g.roles.length > 0);
  return rolePickers(
    {
      roleGroups: list(groups, [{ code: null, roles: groups.map((g) => g.code) }]),
      entityRoles: list(entity, entityGroups),
      placeRoles: list(place, [{ code: null, roles: place.map((r) => r.code) }]),
      relationRoles: list([], []),
    },
    lang,
  );
}

// @version v0.9.0
