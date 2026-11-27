/**
 * Tests — the busy answer on a client navigation, and its place at the root
 *
 * This suite pins the busy answer on a client navigation, and the root
 * error boundary's part in it. A client navigation or fetcher asks for
 * `<path>.data` and expects React Router's single-fetch format, which the
 * router marks with an `X-Remix-Response` header. When such a request
 * fails because D1 refused a read as overloaded, `serviceBusyMiddleware`
 * answers a plain 503 whose body is `SERVICE_BUSY_MARKER`, without that
 * header. The client router turns any 4xx or 5xx response without the
 * header into `new ErrorResponseImpl(res.status, res.statusText, await
 * res.text())` and hands it to the nearest error boundary; the root
 * `ErrorBoundary` recognizes the marker and shows the busy title and
 * detail in the page's language. A 503 without the marker keeps the
 * server-error copy.
 *
 * The full request handler cannot be run here (the server build is a
 * virtual module the test pool cannot resolve; see
 * `tests/routes/error-boundary.test.tsx`), so the suite runs the real
 * middleware against a single-fetch-shaped 500, builds the ErrorResponse
 * from its answer exactly as the client router does, and renders the
 * real boundary with it.
 *
 * The last block pins `serviceBusyMiddleware` as the first entry of the
 * root route's middleware list, ahead of the i18next middleware.
 *
 * @version v0.9.0
 */
import { describe, it, expect, vi } from "vitest";
import { RouterContextProvider, UNSAFE_ErrorResponseImpl } from "react-router";
import { serviceBusyMiddleware } from "../../app/middleware/service-busy";
import { SERVICE_BUSY_MARKER } from "../../app/lib/service-busy-marker";
import { handleError } from "../../app/entry.server";
import { i18nextMiddleware } from "../../app/middleware/i18next";
import { middleware as rootMiddleware } from "../../app/root";

const OVERLOAD = new Error(
  "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window. [code: 7429]",
);

async function i18nFor(lng: "en" | "es") {
  const i18nextModule = await import("i18next");
  const en = (await import("../../app/locales/en")).default;
  const es = (await import("../../app/locales/es")).default;
  const instance = i18nextModule.default.createInstance();
  await (instance.init as (opts: unknown) => Promise<unknown>)({
    lng,
    fallbackLng: "es",
    defaultNS: "common",
    resources: { en: en as Record<string, unknown>, es: es as Record<string, unknown> },
  });
  return instance;
}

async function renderBoundary(error: unknown, lng: "en" | "es"): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { I18nextProvider } = await import("react-i18next");
  const { ErrorBoundary } = await import("../../app/root");
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: await i18nFor(lng) },
      React.createElement(ErrorBoundary as never, { error } as never),
    ),
  );
}

/** Runs the middleware over a single-fetch 500 caused by an overload, as the router would produce it. */
async function busyDataAnswer(): Promise<Response> {
  const request = new Request("https://neogranadina.fisqua.test/dashboard");
  const context = new RouterContextProvider();
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return (await serviceBusyMiddleware({ request, context, params: {} } as any, async () => {
      handleError(OVERLOAD, { request, params: {}, context } as any);
      return new Response("turbo-stream payload", {
        status: 500,
        headers: { "X-Remix-Response": "yes", "Content-Type": "text/x-script" },
      });
    })) as Response;
  } finally {
    quiet.mockRestore();
  }
}

describe("busy answer to a client navigation", () => {
  it("answers a single-fetch request with a plain 503 carrying the marker", async () => {
    const response = await busyDataAnswer();
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Remix-Response")).toBeNull();
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Retry-After")).toBe("10");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe(SERVICE_BUSY_MARKER);
  });

  it.each([
    ["en", "Fisqua is busy right now", "Try again in a few seconds."],
    ["es", "Fisqua está ocupado en este momento", "Intenta de nuevo en unos segundos."],
  ] as const)("shows the busy message in the root boundary (%s)", async (lng, title, detail) => {
    const response = await busyDataAnswer();
    // As the client router builds it from a response without X-Remix-Response.
    const error = new UNSAFE_ErrorResponseImpl(response.status, response.statusText, await response.text());
    const html = await renderBoundary(error, lng);
    expect(html).toContain(title);
    expect(html).toContain(detail);
    expect(html).not.toContain(lng === "en" ? "Something went wrong on our side" : "Algo falló de nuestro lado");
  });

  it("keeps the server-error copy for a 503 without the marker", async () => {
    const html = await renderBoundary(new UNSAFE_ErrorResponseImpl(503, "", "Service Unavailable"), "en");
    expect(html).toContain("Something went wrong on our side");
    expect(html).not.toContain("Fisqua is busy right now");
  });
});

describe("busy answer when an error is thrown past next()", () => {
  async function run(url: string, thrown: unknown, headers: Record<string, string> = {}) {
    const request = new Request(url, { headers });
    const context = new RouterContextProvider();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let outcome: { response?: Response; error?: unknown };
      try {
        const response = await serviceBusyMiddleware({ request, context, params: {} } as any, async () => {
          throw thrown;
        });
        outcome = { response: response as Response };
      } catch (error) {
        outcome = { error };
      }
      return { ...outcome, lines: quiet.mock.calls.map((c) => String(c[0])) };
    } finally {
      quiet.mockRestore();
    }
  }

  it("answers JSON under /api/", async () => {
    const { response, lines } = await run("https://neogranadina.fisqua.test/api/capture/v1/queue", OVERLOAD);
    expect(response!.status).toBe(503);
    expect(response!.headers.get("Retry-After")).toBe("10");
    expect(response!.headers.get("Cache-Control")).toBe("no-store");
    expect(response!.headers.get("Content-Type")).toBe("application/json");
    expect(await response!.json()).toEqual({ error: "service_busy" });
    expect(lines.filter((l) => l.includes('"event":"service_busy_503"'))).toHaveLength(1);
  });

  it("answers JSON elsewhere when the request asks for JSON", async () => {
    const { response } = await run("https://neogranadina.fisqua.test/admin/export.json", OVERLOAD, {
      Accept: "application/json",
    });
    expect(await response!.json()).toEqual({ error: "service_busy" });
  });

  it("answers the plain-text marker otherwise", async () => {
    const { response } = await run("https://neogranadina.fisqua.test/records/download", OVERLOAD, {
      Accept: "*/*",
    });
    expect(response!.status).toBe(503);
    expect(response!.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response!.text()).toBe(SERVICE_BUSY_MARKER);
  });

  it("rethrows any other error unchanged and writes nothing", async () => {
    const other = new Error("D1_ERROR: no such table: record 7429");
    const { error, lines } = await run("https://neogranadina.fisqua.test/api/publish", other);
    expect(error).toBe(other);
    expect(lines).toEqual([]);
  });

  it("answers a resource route's own 500 from an overload in the resource format", async () => {
    const request = new Request("https://neogranadina.fisqua.test/api/publish");
    const context = new RouterContextProvider();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = (await serviceBusyMiddleware({ request, context, params: {} } as any, async () => {
        // A loader's throw: the router calls handleError, then builds a plain-text 500.
        handleError(OVERLOAD, { request, params: {}, context } as any);
        return new Response("Unexpected Server Error", { status: 500, headers: { "X-Remix-Error": "yes" } });
      })) as Response;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "service_busy" });
    } finally {
      quiet.mockRestore();
    }
  });

  it("never replaces a route's own 503, such as the pairing routes' busy answer", async () => {
    const request = new Request("https://neogranadina.fisqua.test/api/capture/v1/pairing/codes", { method: "POST" });
    const context = new RouterContextProvider();
    const own = Response.json({ rule: "busy" }, { status: 503, headers: { "Retry-After": "5" } });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await serviceBusyMiddleware({ request, context, params: {} } as any, async () => {
        handleError(OVERLOAD, { request, params: {}, context } as any);
        return own;
      });
      expect(response).toBe(own);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("root middleware order", () => {
  it("runs serviceBusyMiddleware first, ahead of the i18next middleware", () => {
    expect(rootMiddleware[0]).toBe(serviceBusyMiddleware);
    expect(rootMiddleware).toContain(i18nextMiddleware);
    expect(rootMiddleware.indexOf(serviceBusyMiddleware)).toBeLessThan(
      rootMiddleware.indexOf(i18nextMiddleware),
    );
  });
});

// @version v0.9.0
