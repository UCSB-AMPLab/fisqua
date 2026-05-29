/**
 * Shared Enum Arrays
 *
 * This module deals with the single source of truth for the
 * controlled-vocabulary arrays used by the Drizzle schema, the Zod
 * validation schemas, and the vocabularies admin surfaces. Several of
 * the description-side vocabularies still mirror the legacy Django
 * backend (`catalog/models.py`) exactly so a payload that validates
 * here validates there too; the workflow-side enums (entry types,
 * project roles, QC vocabularies) are Fisqua-native.
 *
 * The contract is simple: every enum here is consumed in three places
 * — the Drizzle column hint (`enum: [...CONST]`), the Zod validator
 * (`z.enum(CONST)` or `(CONST as readonly string[]).includes(x)`), and
 * the derived TypeScript type (`(typeof CONST)[number]`). Adding a
 * value here therefore propagates everywhere, which is the whole point:
 * it removes the hand-copied literal lists that previously let a value
 * be settable in the UI and valid in the DB yet rejected by a stale
 * validator (the `test_images` autosave hang). `tests/db/enum-drift.test.ts`
 * pins each schema column's enum against the constant it must equal.
 *
 * @version v0.4.1
 */

// Description levels
export const DESCRIPTION_LEVELS = [
  "fonds", "subfonds", "series", "subseries",
  "file", "item", "collection", "section", "volume",
] as const;

// Resource types
export const RESOURCE_TYPES = [
  "text", "still_image", "cartographic", "mixed",
] as const;

// Entity types
export const ENTITY_TYPES = ["person", "family", "corporate"] as const;

// EntityFunction certainty levels (from EntityFunction.Certainty)
export const CERTAINTY_LEVELS = ["certain", "probable", "possible"] as const;

// Place types
export const PLACE_TYPES = [
  "country", "region", "department", "province", "partido",
  "city", "town", "parish", "hacienda", "mine", "river", "other",
] as const;

// Entity roles in descriptions
export const ENTITY_ROLES = [
  "creator", "author", "editor", "publisher",
  "sender", "recipient",
  "mentioned", "subject",
  "scribe", "witness", "notary",
  "photographer", "artist",
  "plaintiff", "defendant", "petitioner", "judge", "appellant",
  "apoderado",
  "official",
  "heir", "albacea", "spouse", "victim",
  "grantor", "donor", "seller", "buyer",
  "mortgagor", "mortgagee", "creditor", "debtor", "fiador",
] as const;

// Place roles in descriptions
export const PLACE_ROLES = [
  "created", "subject", "mentioned",
  "sent_from", "sent_to", "published", "venue",
] as const;

// Vocabulary term statuses
export const VOCABULARY_STATUSES = ["approved", "proposed", "deprecated"] as const;

// Function categories for vocabulary terms
export const FUNCTION_CATEGORIES = [
  "civil_office", "military_rank", "ecclesiastical_office", "academic_degree",
  "honorific", "occupation_trade", "documentary_role", "kinship",
  "status_condition", "institutional_ref",
] as const;

// --- Workflow-side enums (Fisqua-native, not Django-mirrored) ---

// Segmentation entry types. `null` (unset) is allowed at the column and
// validator level and is NOT a member here — it is the "no type chosen
// yet" state, distinct from the closed set of chosen types.
export const ENTRY_TYPES = [
  "item", "blank", "front_matter", "back_matter", "test_images",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

// Editor-side (Spanish) resource types used by the entries table and the
// description editor. Distinct from the English `RESOURCE_TYPES` above,
// which is the published/Dublin-Core vocabulary; `lib/promote/types.ts`
// bridges the two (e.g. `texto` -> `text`). Do not conflate them.
export const RESOURCE_TYPES_ES = [
  "texto", "imagen", "cartografico", "mixto",
] as const;
export type ResourceTypeEs = (typeof RESOURCE_TYPES_ES)[number];

// Project membership roles. Used both as a closed validation set ("is
// this a real role") and as the allow-list for member-only mutation
// endpoints. Adding a role here grants it access to every endpoint that
// guards on the full set — intended, but worth knowing.
export const PROJECT_ROLES = ["lead", "cataloguer", "reviewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

// Volume segmentation-lifecycle statuses. The allowed transitions
// between them live in `app/lib/workflow.ts` (a state machine, not a
// flat set); this is just the closed set of valid status values shared
// by the schema column and the `VolumeStatus` type.
export const VOLUME_STATUSES = [
  "unstarted", "in_progress", "segmented", "sent_back", "reviewed", "approved",
] as const;
export type VolumeStatus = (typeof VOLUME_STATUSES)[number];

// Tenant descriptive standards.
export const DESCRIPTIVE_STANDARDS = ["isadg", "dacs", "rad"] as const;

// QC flag problem types and resolution actions (page-level quality
// control). Mirrored by the `qcFlags` table columns.
export const QC_PROBLEM_TYPES = [
  "damaged", "repeated", "out_of_order", "missing", "blank", "other",
] as const;
export const QC_RESOLUTION_ACTIONS = [
  "retake_requested", "reordered", "marked_duplicate", "ignored", "other",
] as const;

// GeoNames feature classes (fixed external vocabulary).
export const GEONAMES_FCLASSES = ["P", "H", "A", "T", "S"] as const;
