/**
 * Tests — role picker options and labels from a federation's lists
 *
 * This suite pins `app/lib/role-options.ts`, which turns one
 * federation's role lists, as `readRoleVocabulary` returns them, into
 * the option groups the pickers render and the code-to-label maps the
 * pages show:
 *
 *   - the entity picker has one group per held role group, in the
 *     lists' order, each labelled in the viewer's language, and the
 *     codes with no held group last, in a group with no key;
 *   - the place picker is flat, in position order;
 *   - only approved codes are offered, and every code of a list has a
 *     label, deprecated and proposed ones included;
 *   - a label missing in the viewer's language falls back to the other
 *     language, and a code with no label at all shows the code;
 *   - a code missing from the maps shows the code itself;
 *   - a relation side takes its label from the relation roles first,
 *     and any other link from the document roles first;
 *   - the current code of a link being edited is offered even when the
 *     list does not offer it.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import {
  entityRoleLabel,
  entityRoleOptions,
  placeRoleLabel,
  rolePickers,
  withCurrentGroup,
  withCurrentOption,
} from "../../app/lib/role-options";
import type { RoleList, RoleVocabulary } from "../../app/lib/vocabulary.server";

const empty: RoleList = { approved: [], deprecated: [], labels: {}, groups: [] };

const VOCABULARY: RoleVocabulary = {
  roleGroups: {
    approved: ["making", "letters"],
    deprecated: [],
    labels: { making: { es: "Producción", en: "Making" }, letters: { es: "Cartas", en: null } },
    groups: [{ code: null, roles: ["making", "letters"] }],
  },
  entityRoles: {
    approved: ["creator", "subject", "sender", "loose"],
    deprecated: ["author"],
    labels: {
      creator: { es: "Creador", en: "Creator" },
      subject: { es: "Tema", en: "Subject" },
      sender: { es: "Remitente", en: null },
      loose: { es: null, en: null },
      author: { es: "Autor", en: "Author" },
      guess: { es: "Propuesto", en: "Proposed" },
      spouse: { es: "Cónyuge", en: "Spouse" },
    },
    groups: [
      { code: "making", roles: ["creator", "subject"] },
      { code: "letters", roles: ["sender"] },
      { code: null, roles: ["loose"] },
    ],
  },
  placeRoles: {
    approved: ["created", "mentioned"],
    deprecated: ["venue"],
    labels: {
      created: { es: "Creado", en: "Created" },
      mentioned: { es: "Mencionado", en: "Mentioned" },
      venue: { es: "Lugar", en: "Venue" },
    },
    groups: [{ code: null, roles: ["created", "mentioned"] }],
  },
  relationRoles: {
    approved: ["parent", "spouse"],
    deprecated: [],
    labels: { parent: { es: "madre o padre", en: "parent" }, spouse: { es: "cónyuge", en: "spouse" } },
    groups: [{ code: null, roles: ["parent", "spouse"] }],
  },
};

describe("rolePickers", () => {
  it("groups the approved entity roles under their group labels, with the ungrouped codes last", () => {
    const p = rolePickers(VOCABULARY, "en");
    expect(p.entityGroups).toEqual([
      { key: "making", label: "Making", options: [{ value: "creator", label: "Creator" }, { value: "subject", label: "Subject" }] },
      { key: "letters", label: "Cartas", options: [{ value: "sender", label: "Remitente" }] },
      { key: null, label: "", options: [{ value: "loose", label: "loose" }] },
    ]);
  });

  it("lists the approved place roles flat, in order, in the viewer's language", () => {
    expect(rolePickers(VOCABULARY, "es").placeOptions).toEqual([
      { value: "created", label: "Creado" },
      { value: "mentioned", label: "Mencionado" },
    ]);
  });

  it("offers no deprecated or proposed code, and labels every code of each list", () => {
    const p = rolePickers(VOCABULARY, "en");
    expect(entityRoleOptions(p).map((o) => o.value)).toEqual(["creator", "subject", "sender", "loose"]);
    expect(p.placeOptions.map((o) => o.value)).not.toContain("venue");
    expect(p.labels.entity.author).toBe("Author");
    expect(p.labels.entity.guess).toBe("Proposed");
    expect(p.labels.place.venue).toBe("Venue");
    expect(p.labels.relation.parent).toBe("parent");
  });

  it("gives empty pickers and maps for a federation with no lists", () => {
    const p = rolePickers({ roleGroups: empty, entityRoles: empty, placeRoles: empty, relationRoles: empty }, "es");
    expect(p).toEqual({ entityGroups: [], placeOptions: [], labels: { entity: {}, place: {}, relation: {} } });
  });
});

describe("role labels", () => {
  const { labels } = rolePickers(VOCABULARY, "es");

  it("shows the code itself for a code missing from the maps", () => {
    expect(entityRoleLabel(labels, "unheard")).toBe("unheard");
    expect(placeRoleLabel(labels, "unheard")).toBe("unheard");
  });

  it("labels a relation side from the relation roles, and any other link from the document roles", () => {
    expect(entityRoleLabel(labels, "spouse", true)).toBe("cónyuge");
    expect(entityRoleLabel(labels, "spouse")).toBe("Cónyuge");
    expect(entityRoleLabel(labels, "parent")).toBe("madre o padre");
    expect(entityRoleLabel(labels, "creator", true)).toBe("Creador");
  });
});

describe("the current code of a link being edited", () => {
  const p = rolePickers(VOCABULARY, "en");

  it("is added ahead of the groups when no group offers it", () => {
    const groups = withCurrentGroup(p.entityGroups, "author", "Author");
    expect(groups[0]).toEqual({ key: null, label: "", options: [{ value: "author", label: "Author" }] });
    expect(groups.slice(1)).toEqual(p.entityGroups);
    expect(withCurrentGroup(p.entityGroups, "creator", "Creator")).toBe(p.entityGroups);
  });

  it("is added ahead of a flat list when the list does not offer it", () => {
    expect(withCurrentOption(p.placeOptions, "venue", "Venue")[0]).toEqual({ value: "venue", label: "Venue" });
    expect(withCurrentOption(p.placeOptions, "created", "Created")).toBe(p.placeOptions);
    expect(withCurrentOption(p.placeOptions, "", "")).toBe(p.placeOptions);
  });
});

// @version v0.9.0
