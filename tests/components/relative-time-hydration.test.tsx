/**
 * Tests — ages rendered across a clock boundary between server and browser
 *
 * This suite checks ages rendered across a clock boundary between server
 * and browser. Five components work out an age while they render: the
 * reviewer dashboard's waiting badge and the description tab's (a count of
 * days), the pipeline card's "N days" label (seconds, not milliseconds),
 * the export history row's remaining-time estimate, and the outline
 * comment card's relative timestamp. Reading the clock during render gives
 * the Worker and the browser different text when a page is rendered just
 * before a boundary and hydrated just after it, and React reports a
 * hydration mismatch.
 *
 * Each case renders the real component on the server through the root
 * loader, moves the clock across the boundary, then renders the
 * hydrating side from the loader data the server produced. The markup
 * of the two must be identical and must still show the pre-boundary
 * text, since both measure from the root loader's `now`. A control
 * renders the same component in a router with no root data after the
 * clock has moved, and must show the post-boundary text, so the cases
 * cannot pass by the boundary simply not being crossed.
 *
 * @version v0.8.0
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import {
  createRoutesStub,
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from "react-router";
import { ReviewerDashboard } from "../../app/components/dashboard/reviewer-dashboard";
import { ReviewerDescriptionTab } from "../../app/components/dashboard/reviewer-description-tab";
import { PipelineCard } from "../../app/components/pipeline/pipeline-card";
import { ExportHistory } from "../../app/components/exports/export-history";
import { OutlineCommentCard } from "../../app/components/outline/outline-comment-card";
import { daysSince } from "../../app/components/dashboard/volume-status-card";
import type { VolumeCardData } from "../../app/components/dashboard/volume-status-card";
import type { ExportRunView } from "../../app/lib/export/run.server";
import type { CommentWithAuthor } from "../../app/lib/description-types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// 2026-10-26T04:46:08.454Z
const REQUEST_TIME = 1792989968454;

async function i18n() {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: "en",
    fallbackLng: "en",
    ns: ["dashboard", "pipeline", "exports", "viewer", "comments"],
    resources: {
      en: {
        dashboard: {
          today: "today",
          days_waiting_one: "{{count}} day waiting",
          days_waiting_other: "{{count}} days waiting",
        },
        pipeline: {
          time_today: "today",
          time_days_one: "{{count}} day",
          time_days_other: "{{count}} days",
        },
        exports: {
          rowLeave: "leave",
          rowLeaveWithEta: "leave, {{eta}}",
          workingEta_one: "{{count}} minute left",
          workingEta_other: "{{count}} minutes left",
        },
        viewer: {},
        comments: {},
      },
    },
    interpolation: { escapeValue: false },
  });
  return inst;
}

async function rootLoader() {
  const { loader } = await import("../../app/root");
  return loader;
}

/**
 * Render `element` on the server at REQUEST_TIME, move the clock on by
 * `advanceMs`, render it again from the loader data the server sent,
 * and render it a third time with no root data as a control.
 */
async function acrossBoundary(element: React.ReactElement, advanceMs: number) {
  vi.useFakeTimers();
  vi.setSystemTime(REQUEST_TIME);

  const loader = await rootLoader();
  const handler = createStaticHandler([
    { id: "root", path: "/", loader: loader as never, Component: () => element },
  ]);
  const context = await handler.query(new Request("https://fisqua.test/"));
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  const server = renderToStaticMarkup(
    <I18nextProvider i18n={await i18n()}>
      <StaticRouterProvider router={router} context={context} hydrate={false} />
    </I18nextProvider>,
  );

  vi.setSystemTime(REQUEST_TIME + advanceMs);

  const Hydrating = createRoutesStub([
    { id: "root", path: "/", Component: () => element },
  ]);
  const client = renderToStaticMarkup(
    <I18nextProvider i18n={await i18n()}>
      <Hydrating
        initialEntries={["/"]}
        hydrationData={{ loaderData: context.loaderData }}
      />
    </I18nextProvider>,
  );

  const NoRoot = createRoutesStub([{ path: "/", Component: () => element }]);
  const control = renderToStaticMarkup(
    <I18nextProvider i18n={await i18n()}>
      <NoRoot initialEntries={["/"]} />
    </I18nextProvider>,
  );

  return { server, client, control };
}

afterEach(() => {
  vi.useRealTimers();
});

function volume(updatedAt: number): VolumeCardData {
  return {
    id: "v1",
    name: "Volume one",
    pageCount: 10,
    entryCount: 2,
    status: "in_review",
    projectId: "p1",
    projectName: "Project",
    updatedAt,
  };
}

describe("daysSince", () => {
  it("measures from an explicit reference time, whatever the clock says", () => {
    vi.useFakeTimers();
    vi.setSystemTime(REQUEST_TIME + 2 * DAY);
    const stamp = REQUEST_TIME - DAY;
    expect(daysSince(stamp, REQUEST_TIME)).toBe(1);
    expect(daysSince(stamp)).toBe(3);
  });
});

describe("reviewer dashboard waiting badge", () => {
  it("shows the same day count when the clock crosses a day boundary before hydration", async () => {
    // A minute short of three days old at the request, three days old
    // two minutes later, which is where the urgent styling starts.
    const stamp = REQUEST_TIME - (3 * DAY - MINUTE);
    const element = (
      <ReviewerDashboard
        groups={{ awaitingReview: [volume(stamp)], reviewed: [], approved: [] }}
      />
    );
    const { server, client, control } = await acrossBoundary(element, 2 * MINUTE);
    expect(server).toContain("2 days waiting");
    expect(server).toContain("bg-saffron-tint");
    expect(client).toBe(server);
    expect(control).toContain("3 days waiting");
    expect(control).toContain("bg-madder-tint");
  });
});

describe("reviewer description tab waiting badge", () => {
  it("shows the same day count when the clock crosses a day boundary before hydration", async () => {
    const stamp = REQUEST_TIME - (3 * DAY - MINUTE);
    const element = (
      <ReviewerDescriptionTab
        data={{
          resegFlags: [],
          awaitingReview: [
            {
              id: "e1",
              title: "Entry",
              translatedTitle: null,
              referenceCode: "AHR-1",
              volumeTitle: "Volume",
              volumeId: "v1",
              projectId: "p1",
              startPage: 1,
              endPage: 2,
              descriptionStatus: "described",
              updatedAt: stamp,
            },
          ],
          reviewed: [],
          approved: [],
        }}
      />
    );
    const { server, client, control } = await acrossBoundary(element, 2 * MINUTE);
    expect(server).toContain("2 days waiting");
    expect(client).toBe(server);
    expect(control).toContain("3 days waiting");
  });
});

describe("pipeline card age", () => {
  it("shows the same label when the clock crosses a day boundary before hydration", async () => {
    // updatedAt is in seconds. Under a day old at the request; a day
    // old two minutes later.
    const updatedAt = Math.floor((REQUEST_TIME - (DAY - MINUTE)) / 1000);
    const element = (
      <PipelineCard
        item={{
          id: "i1",
          name: "Item one",
          assignee: null,
          projectId: "p1",
          projectName: "Project",
          updatedAt,
          isSentBack: false,
          type: "volume",
        }}
        columnId="unstarted"
        isSuperAdmin={false}
      />
    );
    const { server, client, control } = await acrossBoundary(element, 2 * MINUTE);
    expect(server).toContain("today");
    expect(client).toBe(server);
    expect(control).toContain("1 day");
    expect(control).not.toContain("today");
  });
});

function runningExport(startedAt: number): ExportRunView {
  return {
    id: "r1",
    userId: "u1",
    scopeKind: "carried",
    descriptor: null,
    recordClass: "records",
    includeAuthorities: false,
    form: null,
    format: null,
    status: "running",
    stage: "descriptions",
    progressDone: 100,
    progressTotal: 1000,
    counts: { records: 0, entities: 0, places: 0 },
    fileName: null,
    fileSize: null,
    r2Key: null,
    failure: null,
    startedAt,
    finishedAt: null,
    createdAt: startedAt,
  };
}

describe("export history remaining time", () => {
  it("shows the same estimate when the clock moves on before hydration", async () => {
    // 100 of 1000 done after 5 minutes: 45 minutes left at the
    // request, 63 two minutes later.
    const element = (
      <ExportHistory
        runs={[runningExport(REQUEST_TIME - 5 * MINUTE)]}
        onCancel={() => {}}
        onRetry={() => {}}
      />
    );
    const { server, client, control } = await acrossBoundary(element, 2 * MINUTE);
    expect(server).toContain("45 minutes left");
    expect(client).toBe(server);
    expect(control).toContain("63 minutes left");
  });
});

describe("outline comment card timestamp", () => {
  it("shows the same relative time when the clock crosses an hour boundary before hydration", async () => {
    const comment = {
      id: "c1",
      volumeId: "v1",
      entryId: null,
      pageId: null,
      qcFlagId: null,
      regionX: null,
      regionY: null,
      regionW: null,
      regionH: null,
      parentId: null,
      authorId: "u1",
      authorRole: "cataloguer",
      text: "hello",
      createdAt: REQUEST_TIME - 59 * MINUTE,
      updatedAt: null,
      authorEmail: "u1@example.com",
      authorName: null,
    } as unknown as CommentWithAuthor;
    const element = (
      <OutlineCommentCard
        comment={comment}
        replies={[]}
        entrySequence={1}
        ownerEntryId="e1"
        volumeId="v1"
        isHighlighted={false}
        isExpanded={false}
        onToggleExpand={() => {}}
      />
    );
    const { server, client, control } = await acrossBoundary(element, 2 * MINUTE);
    expect(server).toContain("59 minutes ago");
    expect(client).toBe(server);
    expect(control).toContain("1 hour ago");
  });
});

/* @version v0.8.0 */
