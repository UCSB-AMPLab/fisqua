/**
 * Merge search — the address of a list route's `_search` JSON
 *
 * This module deals with the URL the merge surfaces load to find the
 * record or term a merge goes into: the merge workbench's survivor
 * typeahead and the shared merge dialog's search. Each list route
 * (`/admin/entities`, `/admin/places`, `/admin/vocabularies/functions`)
 * answers `?_search=true&q=…&exclude=…` with a JSON array. The callers
 * load it through a React Router fetcher, which runs that route's loader
 * alone and hands back the array: a plain `fetch` of the address is a
 * document request, which renders the list page with the array as its
 * data and fails. `currentSearchResults` shows a load's answer only for
 * the query it was made for.
 *
 * @version v0.9.0
 */

/** The list route's `_search` URL, the query trimmed and `excludeId` left out of the results. */
export function mergeSearchPath(searchEndpoint: string, query: string, excludeId: string): string {
  const params = new URLSearchParams({ _search: "true", q: query.trim(), exclude: excludeId });
  return `${searchEndpoint}?${params}`;
}

/**
 * The results to show for `query`: the fetcher's answer only when it is
 * idle and its last load was made for this query (`requestedFor`). While
 * a newer query waits for its debounce or its answer, an earlier query's
 * results are not shown, so they cannot be chosen.
 */
export function currentSearchResults<T>(
  query: string,
  requestedFor: string | null,
  data: unknown,
  state: "idle" | "loading" | "submitting",
): T[] {
  const q = query.trim();
  if (!q || state !== "idle" || requestedFor !== q || !Array.isArray(data)) return [];
  return data as T[];
}

// @version v0.9.0
