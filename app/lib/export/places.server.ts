/**
 * Place Formatter
 *
 * Maps one Drizzle row off `places` into the shape the published JSON
 * expects. Renames historical-administration columns to the
 * frontend-facing names and filters each place to the descriptions
 * that reference it and are themselves publishable.
 *
 * @version v0.3.0
 */

import type { ExportPlace } from "./types";

/**
 * Map a D1 place row to ExportPlace.
 * Key mappings:
 * - placeType -> place_type AND fclass (legacy frontend alias)
 * - colonialGobernacion -> historical_gobernacion
 * - colonialPartido -> historical_partido
 * - colonialRegion -> historical_region
 */
export function formatPlace(row: {
  placeCode: string | null;
  label: string;
  displayName: string;
  placeType: string | null;
  nameVariants: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinatePrecision: string | null;
  historicalGobernacion: string | null;
  historicalPartido: string | null;
  historicalRegion: string | null;
  countryCode: string | null;
  adminLevel1: string | null;
  adminLevel2: string | null;
  tgnId: string | null;
  hgisId: string | null;
  whgId: string | null;
  wikidataId: string | null;
}): ExportPlace {
  return {
    label: row.label,
    place_code: row.placeCode,
    display_name: row.displayName,
    place_type: row.placeType,
    fclass: row.placeType,
    name_variants: JSON.parse(row.nameVariants ?? "[]"),
    historical_gobernacion: row.historicalGobernacion,
    historical_partido: row.historicalPartido,
    historical_region: row.historicalRegion,
    country_code: row.countryCode,
    admin_level_1: row.adminLevel1,
    admin_level_2: row.adminLevel2,
    latitude: row.latitude,
    longitude: row.longitude,
    coordinate_precision: row.coordinatePrecision,
    tgn_id: row.tgnId,
    hgis_id: row.hgisId,
    whg_id: row.whgId,
    wikidata_id: row.wikidataId,
  };
}

/**
 * Filter places to only those linked to at least one published description.
 * The caller computes linkedPlaceIds from descriptionPlaces where
 * the description has isPublished=true.
 */
export function filterLinkedPlaces<T extends { id: string }>(
  places: T[],
  linkedPlaceIds: Set<string>
): T[] {
  return places.filter((p) => linkedPlaceIds.has(p.id));
}
