/**
 * Tests — the same-origin check at the Worker's fetch handler
 *
 * This suite tests the same-origin check at the Worker's fetch handler.
 * These requests go through the default export of `workers/app.ts`, the
 * Worker's only fetch handler, to show the guard sits in front of
 * routing: a refused request never reaches React Router, and an accepted
 * one does. React Router's request handler is replaced by a stub that
 * answers 200 "reached", because the test pool cannot resolve the
 * compiled server build (`virtual:react-router/server-build`); which
 * route would have answered does not matter to a check that runs first.
 *
 * The cases: a resource route (`/api/comments`) and a document route
 * (a project page) refuse a cross-origin write with the session cookie
 * and pass a same-origin one; the pipeline callback and the Captua
 * capture link still take token requests with no `Origin` and no cookie;
 * `/login` refuses a cross-site submission and passes a same-site one.
 *
 * @version v0.8.0
 */
import { describe, it, expect, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    createRequestHandler: () => async () => new Response("reached", { status: 200 }),
  };
});

const worker = (await import("../../workers/app")).default;

const OWN = "https://neogranadina.fisqua.test";
const ELSEWHERE = "https://evil.example";
const SESSION = "theme=dark; __session=signed-value";

async function send(path: string, init: RequestInit): Promise<Response> {
  const request = new Request(`${OWN}${path}`, init);
  return worker.fetch!(request as any, env as any, createExecutionContext());
}

describe("the Worker's fetch handler", () => {
  it("refuses a cross-origin write with the session cookie to a resource route", async () => {
    const res = await send("/api/comments", {
      method: "POST",
      headers: { Cookie: SESSION, Origin: ELSEWHERE },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("refuses a write with the session cookie and no Origin to a resource route", async () => {
    const res = await send("/api/comments", { method: "POST", headers: { Cookie: SESSION } });
    expect(res.status).toBe(403);
  });

  it("passes a same-origin write with the session cookie to a resource route", async () => {
    const res = await send("/api/comments", {
      method: "POST",
      headers: { Cookie: SESSION, Origin: OWN },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("reached");
  });

  it("refuses a cross-origin write with the session cookie to a document route", async () => {
    for (const path of ["/projects/p1", "/projects/p1.data"]) {
      const res = await send(path, {
        method: "POST",
        headers: { Cookie: SESSION, Origin: ELSEWHERE, "X-Forwarded-Host": "evil.example" },
      });
      expect(res.status).toBe(403);
    }
  });

  it("passes a same-origin write with the session cookie to a document route", async () => {
    const res = await send("/projects/p1", {
      method: "POST",
      headers: { Cookie: SESSION, Origin: OWN },
    });
    expect(res.status).toBe(200);
  });

  it("still takes the pipeline callback's token request with no Origin", async () => {
    const res = await send("/api/pipeline/runs/run-1/volumes/vol-1/callback", {
      method: "POST",
      headers: { Authorization: "Bearer run-token", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("reached");
  });

  it("still takes the capture link's token request with no Origin", async () => {
    const res = await send("/api/capture/v1/manifests", {
      method: "POST",
      headers: { Authorization: "Bearer scanner-token", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("refuses a cross-site login submission and passes a same-site one", async () => {
    const body = new URLSearchParams({ email: "someone@example.test" });
    const crossSite = await send("/login", { method: "POST", headers: { Origin: ELSEWHERE }, body });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("Cache-Control")).toBe("no-store");
    const sameSite = await send("/login", { method: "POST", headers: { Origin: OWN }, body });
    expect(sameSite.status).toBe(200);
    expect(await sameSite.text()).toBe("reached");
  });
});

// @version v0.8.0
