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
  | "place-linker";

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
  sections: ReadonlyArray<SectionConfig>;
  /** Derived helper: which columns are required at this level. */
  requiredFieldsForLevel: (level: DescriptionLevel) => ReadonlyArray<string>;
};

/* @version v0.4.0 */
