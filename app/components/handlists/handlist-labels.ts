/**
 * Handlist label keys — one sentence per kind of thing
 *
 * This module deals with the small problem that a handlist is typed
 * and every sentence about it therefore has to name what it holds.
 * "113 records", "14 entities", "27 places" are three sentences, not
 * one sentence with a noun slotted into it: Spanish agrees the article
 * and any participle with the noun, so a shared frame would be wrong
 * for two thirds of the nouns it meets. The maps below pick the whole
 * key, and every surface — the index, the detail page, the four
 * dialogs — reads them from here rather than composing a key inline,
 * so the three vocabularies can never drift apart between surfaces.
 *
 * `HOLDS_KEYS` is the bare type label the index prints under a count;
 * `HELD_KEYS`, `WILL_EXPORT_KEYS` and `SEARCH_WITHIN_KEYS` are the
 * composed count lines and take `{ count }`.
 *
 * @version v0.7.0
 */
import type { HandlistRecordType } from "~/lib/handlists.server";

/** The bare noun, printed under a mono count on the index. */
export const HOLDS_KEYS: Record<HandlistRecordType, string> = {
  records: "holdsRecords",
  entities: "holdsEntities",
  places: "holdsPlaces",
};

/** "{{count}} records" — what the handlist holds, tombstones included. */
export const HELD_KEYS: Record<HandlistRecordType, string> = {
  records: "metaHeld_records",
  entities: "metaHeld_entities",
  places: "metaHeld_places",
};

/** "{{count}} records will export" — what would actually leave. */
export const WILL_EXPORT_KEYS: Record<HandlistRecordType, string> = {
  records: "metaWillExport_records",
  entities: "metaWillExport_entities",
  places: "metaWillExport_places",
};

/** "Search these {{count}} records…" — the handlist page's own field. */
export const SEARCH_WITHIN_KEYS: Record<HandlistRecordType, string> = {
  records: "searchWithin_records",
  entities: "searchWithin_entities",
  places: "searchWithin_places",
};
