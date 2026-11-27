/**
 * Tests — the row actions on the Descriptions screen
 *
 * This suite renders the Descriptions screen's two views from fixed
 * data, in English and Spanish, and pins the actions a person can take
 * on a description without opening its page:
 *
 *   - the file tree: a row of the Miller columns carries an actions
 *     button named after the description; a repository row carries none,
 *     and neither does a row rendered outside the actions provider;
 *   - the column view: each table row carries the same button;
 *   - the open menu: "Add to handlist" always, the two digitization
 *     queue items only when the workspace may manage the queue
 *     (`canQueue`), and the "below" item never before its count has
 *     come back;
 *   - the preview pane of the file tree: the same actions as buttons,
 *     with the queue ones only under `canQueue`;
 *   - the below count: asked for only for a description with children,
 *     under `canQueue`, never for a repository, and the closed menu
 *     mounts nothing that could ask, so a column of rows costs no
 *     request until one menu opens;
 *   - the menu's placement: below its button when it fits, above when
 *     there is more room there, never past the viewport's sides;
 *   - the menu's keys: the arrows, Home and End move between items and
 *     wrap, and do nothing while the handlist dialog is open over it.
 *
 *   - the level pill: it follows the reference code on the second line,
 *     whole and unabbreviated, and never shares the title's line.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub } from "react-router";
import en from "../../app/locales/en";
import es from "../../app/locales/es";
import { MillerColumn } from "../../app/components/descriptions/miller-column";
import { MetadataPreview } from "../../app/components/descriptions/metadata-preview";
import type { TreeItem } from "../../app/components/descriptions/miller-columns";
import {
  DescriptionActionsProvider,
  belowCountHref,
  placeMenu,
  nextMenuIndex,
} from "../../app/components/descriptions/description-actions";
import DescriptionsPage from "../../app/routes/_auth.admin.descriptions";

function item(overrides: Partial<TreeItem> = {}): TreeItem {
  return {
    id: "d-1",
    title: "Test series one",
    referenceCode: "co-test-s1",
    descriptionLevel: "series",
    dateExpression: null,
    scopeContent: null,
    childCount: 3,
    isPublished: false,
    position: 0,
    repositoryId: "r-1",
    kind: "description",
    ...overrides,
  };
}

const REPO = item({ id: "r-1", title: "Test repository", referenceCode: "co-test", descriptionLevel: "repository", kind: "repository" });

async function i18n(lang: "en" | "es") {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: lang,
    fallbackLng: "es",
    defaultNS: "common",
    resources: { en, es },
    interpolation: { escapeValue: false },
  });
  return inst;
}

async function render(lang: "en" | "es", node: () => React.ReactElement) {
  const Stub = createRoutesStub([{ path: "/admin/descriptions", Component: node }]);
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: await i18n(lang) }, React.createElement(Stub, { initialEntries: ["/admin/descriptions"] })),
  );
}

const column = (items: TreeItem[]) =>
  React.createElement(MillerColumn, {
    title: "Root",
    items,
    filterQuery: "",
    selectedId: null,
    ancestorIds: new Set<string>(),
    onFilterChange: () => {},
    onItemClick: () => {},
  });

describe("the file tree's rows", () => {
  it("give a description an actions button named after it, and a repository none", async () => {
    const html = await render("en", () =>
      React.createElement(DescriptionActionsProvider, { canQueue: true }, column([REPO, item()])),
    );
    expect(html).toContain('aria-label="Actions for Test series one"');
    expect(html).not.toContain("Actions for Test repository");
    // Closed: no menu, so nothing in it can ask for a count.
    expect(html).not.toContain("Add to handlist");
    expect(html).not.toContain("digitization queue");
  });

  it("say it in Spanish", async () => {
    const html = await render("es", () =>
      React.createElement(DescriptionActionsProvider, { canQueue: true }, column([item()])),
    );
    expect(html).toContain('aria-label="Acciones: Test series one"');
  });

  it("carry no actions outside the provider", async () => {
    const html = await render("en", () => column([item()]));
    expect(html).not.toContain("Actions for");
  });
});

describe("the open menu", () => {
  const open = (canQueue: boolean, lang: "en" | "es" = "en") =>
    render(lang, () =>
      React.createElement(DescriptionActionsProvider, { canQueue, initialOpen: item() }, column([item()])),
    );

  it("offers the handlist and both queue actions to someone who may manage the queue", async () => {
    const html = await open(true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Add to handlist");
    expect(html).toContain("Add to digitization queue");
    // The below item waits for its count.
    expect(html).not.toContain("below this");
  });

  it("offers only the handlist without the capability or the permission", async () => {
    const html = await open(false);
    expect(html).toContain("Add to handlist");
    expect(html).not.toContain("digitization queue");
  });

  it("speaks Spanish", async () => {
    const html = await open(true, "es");
    expect(html).toContain("Agregar a una lista de trabajo");
    expect(html).toContain("Agregar a la cola de digitalización");
  });
});

describe("the column view's rows", () => {
  const data = (canQueue: boolean) => ({
    view: "columns" as const,
    items: [
      { id: "d-1", referenceCode: "co-test-s1", title: "Test series one", descriptionLevel: "series", repositoryName: "Test repository", hasDigital: false, parentReferenceCode: null, childCount: 3 },
      { id: "d-2", referenceCode: "co-test-v1", title: "Test volume one", descriptionLevel: "volume", repositoryName: "Test repository", hasDigital: false, parentReferenceCode: "co-test-s1", childCount: 0 },
    ],
    nextCursor: null,
    prevCursor: null,
    total: 2,
    query: null,
    filters: { level: null, repoId: null, hasDigital: null },
    repositories: [],
    canQueue,
  });
  const page = (canQueue: boolean) =>
    render("en", () =>
      React.createElement(DescriptionsPage as React.ComponentType<any>, { loaderData: data(canQueue), actionData: undefined, params: {}, matches: [] }),
    );

  it("give every description an actions button", async () => {
    const html = await page(true);
    expect(html).toContain('aria-label="Actions for Test series one"');
    expect(html).toContain('aria-label="Actions for Test volume one"');
    expect(html).not.toContain("Add to handlist");
  });

  it("keep the button without the queue, for the handlist", async () => {
    const html = await page(false);
    expect(html).toContain('aria-label="Actions for Test series one"');
  });
});

describe("the preview pane", () => {
  const pane = (target: TreeItem, canQueue: boolean) =>
    render("en", () => React.createElement(MetadataPreview, { item: target, canQueue }));

  it("shows the actions as buttons, the queue ones only under canQueue", async () => {
    const withQueue = await pane(item(), true);
    expect(withQueue).toContain("Add to handlist");
    expect(withQueue).toContain("Add to digitization queue");
    const without = await pane(item(), false);
    expect(without).toContain("Add to handlist");
    expect(without).not.toContain("digitization queue");
  });

  it("shows nothing for a repository", async () => {
    expect(await pane(REPO, true)).toBe("");
  });
});

describe("the below count", () => {
  it("is asked for only for a description with children, under canQueue", () => {
    expect(belowCountHref(item(), true)).toBe("/admin/capture/queue/add?below=d-1");
    expect(belowCountHref(item(), false)).toBeNull();
    expect(belowCountHref(item({ childCount: 0 }), true)).toBeNull();
    expect(belowCountHref(REPO, true)).toBeNull();
  });
});

describe("the menu's placement", () => {
  const viewport = { width: 1000, height: 800 };
  const panel = { width: 288, height: 200 };

  it("opens below the button, right edges aligned, when it fits", () => {
    expect(placeMenu({ top: 100, bottom: 128, right: 600 }, panel, viewport)).toEqual({ left: 312, top: 132, maxHeight: 660 });
  });

  it("opens above the button near the bottom of the screen", () => {
    expect(placeMenu({ top: 700, bottom: 728, right: 600 }, panel, viewport)).toEqual({ left: 312, bottom: 104, maxHeight: 688 });
  });

  it("stays below when there is at least as much room there, and scrolls", () => {
    const tall = { width: 288, height: 900 };
    expect(placeMenu({ top: 300, bottom: 328, right: 600 }, tall, viewport)).toEqual({ left: 312, top: 332, maxHeight: 460 });
  });

  it("keeps inside the viewport's sides", () => {
    expect(placeMenu({ top: 100, bottom: 128, right: 100 }, panel, viewport).left).toBe(8);
    expect(placeMenu({ top: 100, bottom: 128, right: 1200 }, panel, viewport).left).toBe(1000 - 288 - 8);
    expect(placeMenu({ top: 100, bottom: 128, right: 200 }, panel, { width: 250, height: 800 }).left).toBe(8);
  });
});

describe("the menu's keys", () => {
  it("move between items and wrap", () => {
    expect(nextMenuIndex("ArrowDown", 3, 0, false)).toBe(1);
    expect(nextMenuIndex("ArrowDown", 3, 2, false)).toBe(0);
    expect(nextMenuIndex("ArrowUp", 3, 0, false)).toBe(2);
    expect(nextMenuIndex("ArrowUp", 3, -1, false)).toBe(2);
    expect(nextMenuIndex("ArrowDown", 3, -1, false)).toBe(0);
    expect(nextMenuIndex("Home", 3, 2, false)).toBe(0);
    expect(nextMenuIndex("End", 3, 0, false)).toBe(2);
  });

  it("do nothing while the handlist dialog is open, for other keys, or for an empty menu", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) expect(nextMenuIndex(key, 3, 0, true)).toBeNull();
    expect(nextMenuIndex("Enter", 3, 0, false)).toBeNull();
    expect(nextMenuIndex("ArrowDown", 0, -1, false)).toBeNull();
  });
});


describe("the file tree's level pill", () => {
  const long = item({
    title: "Bench volume of petitions",
    referenceCode: "co-test-v1",
    descriptionLevel: "volume",
  });

  it("sits with the reference code, after it, and not beside the title", async () => {
    const html = await render("es", () =>
      React.createElement(DescriptionActionsProvider, { canQueue: true }, column([long])),
    );
    const pill = html.indexOf('data-testid="level-pill"');
    const code = html.indexOf("co-test-v1");
    const title = html.indexOf("Bench volume of petitions");
    expect(pill).toBeGreaterThan(code);
    expect(code).toBeGreaterThan(title);
    // The title paragraph closes before the line that holds the code and pill.
    const titleEnd = html.indexOf("</p>", title);
    expect(titleEnd).toBeLessThan(code);
    // The pill is inside the same block as the code, not a sibling of the
    // title's flex row.
    const between = html.slice(code, pill);
    expect(between).not.toContain("</div>");
  });

  it("shows the full level name", async () => {
    const html = await render("es", () =>
      React.createElement(DescriptionActionsProvider, { canQueue: true }, column([long])),
    );
    const label = (es as any).descriptions_admin.level_volume;
    expect(label.length).toBeGreaterThan(3);
    expect(html).toContain(`>${label}</span>`);
  });
});

// @version v0.9.0
