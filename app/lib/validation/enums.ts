/**
 * Shared Enum Arrays
 *
 * Single source of truth for every controlled vocabulary the schema
 * and the Zod validators depend on: description levels, resource
 * types, entity types, place types, role labels for description
 * links, vocabulary statuses, and function categories. Keeping these
 * arrays in one file means the Drizzle schema and the Zod schemas
 * cannot drift apart -- a new description level added here lands in
 * both layers at once, and the TypeScript literal-union inference
 * surfaces the new value to every consumer at compile time.
 * Values mirror the Django backend (catalog/models.py) exactly.
 */

// Description levels (9 values from Description.Level)
export const DESCRIPTION_LEVELS = [
  "fonds", "subfonds", "series", "subseries",
  "file", "item", "collection", "section", "volume",
] as const;

// Resource types (from Description.ResourceType)
export const RESOURCE_TYPES = [
  "text", "still_image", "cartographic", "mixed",
] as const;

// Entity types (3 values from Entity.EntityType)
export const ENTITY_TYPES = ["person", "family", "corporate"] as const;

// EntityFunction certainty levels (from EntityFunction.Certainty)
export const CERTAINTY_LEVELS = ["certain", "probable", "possible"] as const;

// Place types (12 values from Place.PlaceType)
export const PLACE_TYPES = [
  "country", "region", "department", "province", "partido",
  "city", "town", "parish", "hacienda", "mine", "river", "other",
] as const;

// Entity roles in descriptions (30 values from DescriptionEntity.Role)
export const ENTITY_ROLES = [
  "creator", "author", "editor", "publisher",
  "sender", "recipient",
  "mentioned", "subject",
  "scribe", "witness", "notary",
  "photographer", "artist",
  "plaintiff", "defendant", "petitioner", "judge", "appellant",
  "official",
  "heir", "albacea", "spouse", "victim",
  "grantor", "donor", "seller", "buyer",
  "mortgagor", "mortgagee", "creditor", "debtor",
] as const;

// Place roles in descriptions (7 values from DescriptionPlace.Role)
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
