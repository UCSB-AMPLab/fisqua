/**
 * Tests — the merge workbench's survivor search
 *
 * This suite pins the survivor search of the merge workbench. The
 * workbench's typeahead asks the list route (`/admin/entities`,
 * `/admin/places`) for `_search` results, which its loader answers with
 * JSON. Requested as a document, the URL renders the list page, and React
 * Router hands the page the parsed array as its loader data, where the
 * page reads `entities`: a TypeError, and no results. When the URL is
 * loaded as a fetcher, React Router runs that route's loader alone and
 * returns the array. The suite pins both through React Router's static
 * handler with a loader that answers as the list route does, and the URL
 * the typeahead loads (`typeaheadPath`). The typeahead's effect itself
 * needs a DOM, which the suite does not have.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { createStaticHandler } from "react-router";
import { currentSearchResults, mergeSearchPath as typeaheadPath } from "../../app/lib/merge-search";

const RESULTS = [{ id: "ent-s", displayName: "Domingo Caycedo", code: "ne-s1" }];

const handler = createStaticHandler([
  {
    id: "list",
    path: "/admin/entities",
    loader: ({ request }) =>
      new URL(request.url).searchParams.get("_search") === "true" ? Response.json(RESULTS) : { entities: [] },
  },
]);

describe("the survivor search", () => {
  it("loads the list route's _search URL, the query trimmed and the loser excluded", () => {
    expect(typeaheadPath("/admin/entities", "  Caycedo ", "ent-l")).toBe("/admin/entities?_search=true&q=Caycedo&exclude=ent-l");
  });

  it("shows a load's results only for the query it was made for, once it has answered", () => {
    const first = [{ id: "e-1" }];
    // The answer for "Cay" is shown while the box reads "Cay".
    expect(currentSearchResults(" Cay ", "Cay", first, "idle")).toEqual(first);
    // The box cleared and "Gil" typed: during the debounce the answer is still Cay's, and is not shown.
    expect(currentSearchResults("Gil", "Cay", first, "idle")).toEqual([]);
    // Gil's load in flight: nothing shown until it answers.
    expect(currentSearchResults("Gil", "Gil", first, "loading")).toEqual([]);
    expect(currentSearchResults("", "Cay", first, "idle")).toEqual([]);
    expect(currentSearchResults("Gil", "Gil", undefined, "idle")).toEqual([]);
  });

  it("as a document request, gives the list page the array as its data, which has no entities", async () => {
    const context = await handler.query(new Request(`http://fisqua.test${typeaheadPath("/admin/entities", "Cay", "ent-l")}`));
    if (context instanceof Response) throw new Error("expected a render context");
    expect(context.loaderData.list).toEqual(RESULTS);
    expect((context.loaderData.list as { entities?: unknown[] }).entities).toBeUndefined();
  });

  it("as a fetcher load of that one route, returns the array", async () => {
    const res = await handler.queryRoute(new Request(`http://fisqua.test${typeaheadPath("/admin/entities", "Cay", "ent-l")}`), { routeId: "list" });
    const data = res instanceof Response ? await res.json() : res;
    expect(data).toEqual(RESULTS);
  });
});

// @version v0.9.0
