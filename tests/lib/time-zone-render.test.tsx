/**
 * Tests — the reader's time zone, from request to hydration
 *
 * This suite follows the zone a page's dates are formatted in from the
 * request to the browser. The root loader in `app/root.tsx` reads the
 * request's `tz` cookie and returns `timeZone`; `useFormatters()`
 * reads that value from the router state, on the server and in the
 * hydrating browser alike. If the two sides formatted in different
 * zones, a timestamp near midnight would read as different days and
 * React would report a hydration mismatch.
 *
 * The server half runs the root loader through a static handler, as
 * the Worker does, and renders a component that formats one timestamp
 * through `useFormatters()`. The client half renders the same
 * component in a memory router hydrated with the loader data the
 * server produced, as the browser does. The two renders must produce
 * identical markup, on the calendar of the cookie's zone, and on a
 * first visit with no cookie both must use `America/Los_Angeles` —
 * not the zone of the process running the test, which here is UTC and
 * would put the timestamp on the next day.
 *
 * Relative times ("hace 59 minutos") are measured from the root
 * loader's `now`, not from the clock at render. The relative-time
 * block renders on the server, advances the clock across a minute
 * boundary, then renders the hydrating side from the loader data the
 * server produced; the markup must still be identical. Without root
 * data the clock is used.
 *
 * The last block follows a page after hydration. A first visit renders
 * in `America/Los_Angeles`; the browser then writes `tz=Asia/Tokyo`.
 * On the next navigation the root's `shouldRevalidate` must re-run the
 * root loader with the child loaders, so the root's zone and every
 * date on the new page follow the cookie, as they must when another
 * tab rewrites it. Without that export the root would keep the zone of
 * the first page.
 *
 * @version v0.8.0
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import {
  createMemoryRouter,
  createRoutesStub,
  createStaticHandler,
  createStaticRouter,
  Outlet,
  RouterProvider,
  StaticRouterProvider,
  useLoaderData,
} from "react-router";
import { useFormatters } from "../../app/lib/use-formatters";

// 2026-10-26T04:46:08.454Z: 25 October in Los Angeles, 26 October in
// Tokyo and in UTC.
const NEAR_MIDNIGHT = 1792989968454;

function Probe() {
  const { formatDate, formatIsoDateTime, timeZone } = useFormatters();
  return (
    <p data-zone={timeZone}>
      {formatDate(NEAR_MIDNIGHT)} | {formatIsoDateTime(NEAR_MIDNIGHT)}
    </p>
  );
}

async function i18n() {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: "en",
    fallbackLng: "es",
    resources: { en: {}, es: {} },
    interpolation: { escapeValue: false },
  });
  return inst;
}

async function rootLoader() {
  const { loader } = await import("../../app/root");
  return loader;
}

/** The Worker's side: run the root loader, render from its result. */
async function renderOnServer(cookie: string | null) {
  const loader = await rootLoader();
  const handler = createStaticHandler([
    { id: "root", path: "/", loader: loader as never, Component: Probe },
  ]);
  const request = new Request("https://fisqua.test/", {
    headers: cookie === null ? {} : { Cookie: cookie },
  });
  const context = await handler.query(request);
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={await i18n()}>
      <StaticRouterProvider router={router} context={context} hydrate={false} />
    </I18nextProvider>,
  );
  return { html, loaderData: context.loaderData };
}

/** The browser's side: hydrate from the loader data the server sent. */
async function renderOnClient(loaderData: Record<string, unknown>) {
  const loader = await rootLoader();
  const Stub = createRoutesStub([
    { id: "root", path: "/", loader: loader as never, Component: Probe },
  ]);
  return renderToStaticMarkup(
    <I18nextProvider i18n={await i18n()}>
      <Stub initialEntries={["/"]} hydrationData={{ loaderData }} />
    </I18nextProvider>,
  );
}

describe("time zone from request to hydration", () => {
  it("returns the cookie's zone from the root loader", async () => {
    const { loaderData } = await renderOnServer("tz=Asia%2FTokyo");
    expect(loaderData).toEqual({
      root: { timeZone: "Asia/Tokyo", now: expect.any(Number) },
    });
  });

  it("formats on the server and the client in the cookie's zone", async () => {
    const server = await renderOnServer("tz=Asia%2FTokyo");
    const client = await renderOnClient(server.loaderData);
    expect(server.html).toContain("October 26, 2026 | 2026-10-26 13:46:08");
    expect(client).toContain("October 26, 2026 | 2026-10-26 13:46:08");
    expect(client).toBe(server.html);
  });

  it("formats a first visit, with no cookie, in America/Los_Angeles on both sides", async () => {
    const server = await renderOnServer(null);
    const client = await renderOnClient(server.loaderData);
    expect(server.loaderData).toEqual({
      root: { timeZone: "America/Los_Angeles", now: expect.any(Number) },
    });
    expect(server.html).toContain("October 25, 2026 | 2026-10-25 21:46:08");
    expect(client).toBe(server.html);
  });

  it("falls back to America/Los_Angeles for a cookie Intl rejects", async () => {
    const server = await renderOnServer("tz=Mars%2FOlympus_Mons");
    expect(server.loaderData).toEqual({
      root: { timeZone: "America/Los_Angeles", now: expect.any(Number) },
    });
    expect(server.html).toContain("October 25, 2026");
  });

  it("uses America/Los_Angeles in a router with no root data", async () => {
    const Stub = createRoutesStub([{ path: "/", Component: Probe }]);
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={await i18n()}>
        <Stub initialEntries={["/"]} />
      </I18nextProvider>,
    );
    expect(html).toContain("October 25, 2026 | 2026-10-25 21:46:08");
  });
});

/** A record page: its loader sends a raw timestamp, as the authority
 *  pages send their status band's, and the page formats it. */
function RecordPage() {
  const { createdAt } = useLoaderData() as { createdAt: number };
  const { formatIsoDateTime } = useFormatters();
  return <p>band {formatIsoDateTime(createdAt).slice(0, 10)}</p>;
}

async function navigatingRouter(withShouldRevalidate: boolean) {
  const root = await import("../../app/root");
  const jar = { cookie: null as string | null };
  const routes = [
    {
      id: "root",
      path: "/",
      // The browser's request carries whatever cookie is set now.
      loader: ({ request }: { request: Request }) =>
        root.loader({
          request: new Request(request.url, {
            headers: jar.cookie === null ? {} : { Cookie: jar.cookie },
          }),
        } as never),
      ...(withShouldRevalidate ? { shouldRevalidate: root.shouldRevalidate } : {}),
      Component: Outlet,
      children: [
        { id: "a", path: "a", loader: () => ({ createdAt: NEAR_MIDNIGHT }), Component: RecordPage },
        { id: "b", path: "b", loader: () => ({ createdAt: NEAR_MIDNIGHT }), Component: RecordPage },
      ],
    },
  ];
  // Hydrated from a first visit: no cookie, so the server used the default.
  const router = createMemoryRouter(routes, {
    initialEntries: ["/a"],
    hydrationData: {
      loaderData: {
        root: { timeZone: "America/Los_Angeles" },
        a: { createdAt: NEAR_MIDNIGHT },
      },
    },
  });
  return { router, jar };
}

describe("time zone after the cookie changes", () => {
  it("re-runs the root loader on the next navigation and formats in the new zone", async () => {
    const { router, jar } = await navigatingRouter(true);
    jar.cookie = "tz=Asia%2FTokyo";
    await router.navigate("/b");
    expect(router.state.loaderData.root).toMatchObject({ timeZone: "Asia/Tokyo" });
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={await i18n()}>
        <RouterProvider router={router} />
      </I18nextProvider>,
    );
    expect(html).toContain("band 2026-10-26");

    // Another tab rewrites the cookie; the next navigation follows it.
    jar.cookie = "tz=America%2FBogota";
    await router.navigate("/a");
    expect(router.state.loaderData.root).toMatchObject({
      timeZone: "America/Bogota",
    });
    router.dispose();
  });

  it("keeps the first page's zone without the root's shouldRevalidate", async () => {
    const { router, jar } = await navigatingRouter(false);
    jar.cookie = "tz=Asia%2FTokyo";
    await router.navigate("/b");
    expect(router.state.loaderData.root).toEqual({
      timeZone: "America/Los_Angeles",
    });
    router.dispose();
  });
});

/** Renders one timestamp through `relativeTime`, as a dashboard card does. */
function AgeProbe({ stamp }: { stamp: number }) {
  const { relativeTime } = useFormatters();
  return <p>{relativeTime(stamp)}</p>;
}

async function renderAgeOnServer(stamp: number) {
  const loader = await rootLoader();
  const handler = createStaticHandler([
    {
      id: "root",
      path: "/",
      loader: loader as never,
      Component: () => <AgeProbe stamp={stamp} />,
    },
  ]);
  const context = await handler.query(new Request("https://fisqua.test/"));
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={await i18n()}>
      <StaticRouterProvider router={router} context={context} hydrate={false} />
    </I18nextProvider>,
  );
  return { html, loaderData: context.loaderData };
}

async function renderAgeOnClient(
  stamp: number,
  loaderData: Record<string, unknown>,
) {
  const Stub = createRoutesStub([
    { id: "root", path: "/", Component: () => <AgeProbe stamp={stamp} /> },
  ]);
  return renderToStaticMarkup(
    <I18nextProvider i18n={await i18n()}>
      <Stub initialEntries={["/"]} hydrationData={{ loaderData }} />
    </I18nextProvider>,
  );
}

describe("relative time from request to hydration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the same text when the clock crosses a bucket boundary before hydration", async () => {
    const requestTime = 1792989968454;
    const stamp = requestTime - 59 * 60000;
    vi.useFakeTimers();
    vi.setSystemTime(requestTime);
    const server = await renderAgeOnServer(stamp);
    expect(server.html).toContain("59 minutes ago");

    // The browser hydrates two minutes later: the clock alone reads
    // "1 hour ago".
    vi.setSystemTime(requestTime + 2 * 60000);
    const client = await renderAgeOnClient(stamp, server.loaderData);
    expect(client).toBe(server.html);
  });

  it("returns the request time from the root loader", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1792989968454);
    const { loaderData } = await renderAgeOnServer(1792989968454 - 1000);
    expect(loaderData).toEqual({
      root: { timeZone: "America/Los_Angeles", now: 1792989968454 },
    });
  });

  it("falls back to the clock in a router with no root data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1792989968454);
    const Stub = createRoutesStub([
      { path: "/", Component: () => <AgeProbe stamp={1792989968454 - 59 * 60000} /> },
    ]);
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={await i18n()}>
        <Stub initialEntries={["/"]} />
      </I18nextProvider>,
    );
    expect(html).toContain("59 minutes ago");
  });
});

/* @version v0.8.0 */
