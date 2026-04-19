/**
 * Export Record Types
 *
 * TypeScript shapes for the JSON records the publish pipeline emits.
 * Each interface mirrors exactly one published artefact (description,
 * repository, entity, place, nested child entry) so the formatters
 * and the R2 writers cannot drift apart without a compiler error.
 *
 * @version v0.3.0
 */

/** Description record in the exported descriptions.json */
export interface ExportDescription {
  id: string;
  repository_code: string;
  country: string;
  reference_code: string;
  local_identifier: string;
  title: string;
  description_level: string;
  date_expression: string | null;
  date_start: string | null;
  parent_id: string | null;
  parent_reference_code: string | null;
  has_children: boolean;
  child_count: number;
  children_level: string | null;
  has_digital: boolean;
  iiif_manifest_url: string;
  mets_url: string;
  scope_content: string | null;
  ocr_text: string | null;
  extent: string | null;
  arrangement: string | null;
  access_conditions: string | null;
  reproduction_conditions: string | null;
  language: string | null;
  location_of_originals: string | null;
  location_of_copies: string | null;
  related_materials: string | null;
  finding_aids: string | null;
  notes: string | null;
  publication_title: string | null;
  imprint: string | null;
  edition_statement: string | null;
  series_statement: string | null;
  uniform_title: string | null;
  section_title: string | null;
  pages: string | null;
  creator_display: string | null;
  place_display: string | null;
}

/** Repository record in repositories.json, with nested root_descriptions */
export interface ExportRepository {
  id: string;
  code: string;
  name: string;
  short_name: string | null;
  country_code: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  website: string | null;
  description_count: number;
  image_reproduction_text: string;
  display_title: string | null;
  subtitle: string | null;
  hero_image_url: string | null;
  root_descriptions: Omit<ExportDescription, "ocr_text">[];
}

/** Entity record in entities.json */
export interface ExportEntity {
  entity_code: string | null;
  display_name: string;
  sort_name: string;
  given_name: string | null;
  particle: string | null;
  surname: string | null;
  entity_type: string;
  honorific: string | null;
  primary_function: string | null;
  name_variants: string[];
  dates_of_existence: string | null;
  date_earliest: string | null;
  date_latest: string | null;
  date_start: string | null;
  date_end: string | null;
  history: string | null;
  legal_status: string | null;
  functions: string | null;
  sources: string | null;
  wikidata_id: string | null;
  viaf_id: string | null;
}

/** Place record in places.json */
export interface ExportPlace {
  label: string;
  place_code: string | null;
  display_name: string;
  place_type: string | null;
  fclass: string | null;
  name_variants: string[];
  historical_gobernacion: string | null;
  historical_partido: string | null;
  historical_region: string | null;
  country_code: string | null;
  admin_level_1: string | null;
  admin_level_2: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinate_precision: string | null;
  tgn_id: string | null;
  hgis_id: string | null;
  whg_id: string | null;
  wikidata_id: string | null;
}

/** Entry in children/{referenceCode}.json */
export interface ExportChildEntry {
  id: string;
  reference_code: string;
  title: string;
  description_level: string;
  date_expression: string | null;
  has_children: boolean;
  child_count: number;
  has_digital: boolean;
}

/** Export run progress record */
export interface ExportProgress {
  exportId: string;
  status: "pending" | "running" | "complete" | "error";
  currentStep: string | null;
  stepsCompleted: number;
  totalSteps: number;
  recordCounts: Record<string, number>;
  errorMessage: string | null;
}
