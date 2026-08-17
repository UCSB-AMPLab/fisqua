/**
 * Standard Config Types
 *
 * This module deals with the shared type substrate for the
 * per-standard descriptive config family. Every `StandardConfig`
 * instance — `ISADG_CONFIG`, `DACS_CONFIG`,
 * `RAD_CONFIG` — declares its sections, fields, primitives, and
 * per-level mandatoriness here, and both the universal renderer and
 * the Zod validator factory consume `StandardConfig` instances rather
 * than knowing about individual standards.
 *
 * The `Standard` literal union MUST match the SQLite CHECK on
 * `tenants.descriptive_standard` (drizzle/0034_tenants_table.sql) and
 * the Drizzle `enum: ["isadg","dacs","rad"]` constraint in
 * `app/db/schema.ts` byte-for-byte. Drift would silently let a tenant
 * row through that the validator factory rejects (or vice versa).
 *
 * The `DescriptionLevel` union mirrors `DESCRIPTION_LEVELS` in
 * `app/lib/validation/enums.ts` member-for-member; that enum is the
 * canonical level set across all three standards (the level enum is
 * standard-neutral). If `DESCRIPTION_LEVELS` ever grows, this union
 * grows with it.
 *
 * @version v0.4.0
 */

/**
 * Closed set of descriptive standards Fisqua supports as PRIMARY
 * cataloguing standards (Dublin Core is export-only; EAD3 is export
 * with per-standard profiles — neither is a value here). One immutable
 * standard per tenant for v0.4.
 *
 * MUST match `app/db/schema.ts:120` `tenants.descriptiveStandard`
 * `enum: ["isadg", "dacs", "rad"]` byte-for-byte.
 */
export type Standard = "isadg" | "dacs" | "rad";

/**
 * Closed set of description levels. Standard-neutral: ISAD(G), DACS,
 * and RAD all use this exact enum (with their own per-standard
 * mandatoriness rules per level — see `requiredFieldsForLevel` on
 * each `StandardConfig`).
 *
 * Mirrors `DESCRIPTION_LEVELS` in `app/lib/validation/enums.ts` and
 * `descriptions.descriptionLevel` in `app/db/schema.ts:660`.
 */
export type DescriptionLevel =
  | "fonds"
  | "subfonds"
  | "series"
  | "subseries"
  | "file"
  | "item"
  | "collection"
  | "section"
  | "volume";

/**
 * The renderer maps `primitive` → existing JSX component. The set is
 * closed: a new primitive lands only when a real per-standard need
 * arises. The current set covers the primitives the existing ISAD(G)
 * form (`app/components/descriptions/description-form.tsx`) already
 * uses.
 */
export type Primitive =
  | "text"
  | "textarea"
  | "date"
  | "date-range"
  | "level-select"
  | "resource-type-select"
  | "repository-select"
  | "checkbox"
  | "iiif-url"
  | "entity-linker"
  | "place-linker"
  | "legacy-ids";

/**
 * A single field inside a section. `column` MUST exist on
 * `descriptions` in `app/db/schema.ts` — otherwise the renderer would
 * dereference `description[column]` to `undefined` and the validator
 * factory would emit a "required" error on a column that no row can
 * ever populate. `requiredAt` lists the levels at which THIS standard
 * (the parent `StandardConfig`) treats the column as mandatory.
 */
export type FieldConfig = {
  /** Column name on `descriptions` (English; matches schema column). */
  column: string;
  primitive: Primitive;
  /** Levels at which this field is REQUIRED for this standard. */
  requiredAt: ReadonlyArray<DescriptionLevel>;
  /** Optional pass-through hints to the renderer (rows, placeholder, etc.). */
  hints?: { rows?: number; placeholder?: string };
  /**
   * The element number this column answers to IN THIS STANDARD — e.g.
   * `"3.1.1"` for ISAD(G) reference code. Its presence declares that
   * the form should offer the standard's own words about the field,
   * and the number is rendered as the citation beside them.
   *
   * The quoted text itself lives in the locale bundles under
   * `guidance.<standard>.<column>`, because it is translated. The two
   * halves are deliberately keyed by standard with NO cross-standard
   * fallback: a DACS tenant falling back to ISAD(G)'s wording under a
   * DACS citation would be a false attribution, which is worse than
   * no guidance at all. `tests/standards/guidance-coverage.test.ts`
   * holds citation and text in lockstep so neither can appear alone.
   */
  guidance?: string;
};

/**
 * A section is a collapsible block in the form (e.g. "Identity",
 * "Conditions of Access"). The `id` is a stable English identifier
 * resolved by i18n via `descriptions:sections.<id>`; the
 * user-visible label is translated.
 */
export type SectionConfig = {
  /**
   * Stable English ID, e.g. 'identity', 'context'. Resolved in i18n
   * via `descriptions:sections.<id>`. Per-standard label overrides
   * resolve via `descriptions:sections.<id>.<standard>` if defined.
   */
  id: string;
  fields: ReadonlyArray<FieldConfig>;
};

/**
 * Per-standard configuration. The renderer iterates `sections`; the
 * validator factory consumes `requiredFieldsForLevel(level)` to layer
 * `.check()` mandatoriness on top of the base union schema in
 * `app/lib/validation/description.ts`.
 *
 * Adding a fourth standard = adding a new module that exports a
 * `StandardConfig` and registering it in `app/lib/standards/registry.ts`.
 */
export type StandardConfig = {
  standard: Standard;
  /**
   * How the standard names itself in a citation ("ISAD(G)", "DACS",
   * "RAD"). It lives here rather than in a locale bundle because it
   * is a proper noun, identical in every language, and because the
   * description surface is forbidden from naming a standard in copy
   * (tests/standards/no-hardcoded-standards.test.ts) — the config is
   * the sanctioned home for the literal. An attributed quotation is
   * the one place the name legitimately reaches the reader.
   */
  displayName: string;
  /**
   * Whether this standard's field guidance is the standard's OWN words
   * or our summary of them. It governs presentation, not storage: a
   * verbatim statement renders inside quotation marks over a bare
   * citation, a summary renders unquoted and the citation says the text
   * is based on the element rather than taken from it.
   *
   * RAD is the reason this exists. Its text is all rights reserved, so
   * it is summarised rather than quoted; showing a summary in quotation
   * marks would attribute our sentence to the Canadian Council of
   * Archives, which is the misattribution this whole feature is built
   * to avoid.
   */
  guidanceVerbatim: boolean;
  sections: ReadonlyArray<SectionConfig>;
  /** Derived helper: which columns are required at this level. */
  requiredFieldsForLevel: (level: DescriptionLevel) => ReadonlyArray<string>;
};

/* @version v0.4.0 */
