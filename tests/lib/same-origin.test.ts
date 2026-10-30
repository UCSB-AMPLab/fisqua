/**
 * Tests — the same-origin check for resource actions
 *
 * `requireSameOrigin` lets GET and HEAD through and requires any other
 * request to name, by `Origin` or else `Referer`, the scheme and host of
 * the request's own URL, a host the Worker serves by its configuration.
 * This suite pins each refusal as a bare 403 and that `X-Forwarded-Host`
 * changes nothing. Every host here is a test host.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { isServedHost, requireSameOrigin } from "../../app/lib/same-origin.server";

const OWN = "https://neogranadina.fisqua.test";
const SIBLING = "https://second-tenant.fisqua.test";

function post(url: string, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request(url, { method, headers });
}

function refusal(request: Request, env = {}): number | null {
  try {
    requireSameOrigin(request, env);
    return null;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

describe("requireSameOrigin", () => {
  it("lets GET and HEAD through without either header", () => {
    expect(refusal(post(`${OWN}/x`, {}, "GET"))).toBeNull();
    expect(refusal(post(`${OWN}/x`, {}, "HEAD"))).toBeNull();
  });

  it("passes a post from the request's own origin, by Origin or by Referer", () => {
    expect(refusal(post(`${OWN}/x`, { Origin: OWN }))).toBeNull();
    expect(refusal(post(`${OWN}/x`, { Referer: `${OWN}/admin/capture/volumes` }))).toBeNull();
  });

  it("refuses a post from a sibling host of the same site", () => {
    expect(refusal(post(`${OWN}/x`, { Origin: SIBLING }))).toBe(403);
    expect(refusal(post(`${OWN}/x`, { Referer: `${SIBLING}/page` }))).toBe(403);
    // Origin is read first: a matching Referer does not rescue it.
    expect(refusal(post(`${OWN}/x`, { Origin: SIBLING, Referer: `${OWN}/page` }))).toBe(403);
  });

  it("refuses a post with neither header, with Origin null, or with another scheme", () => {
    expect(refusal(post(`${OWN}/x`))).toBe(403);
    expect(refusal(post(`${OWN}/x`, { Origin: "null" }))).toBe(403);
    expect(refusal(post(`${OWN}/x`, { Origin: "http://neogranadina.fisqua.test" }))).toBe(403);
    expect(refusal(post(`${OWN}/x`, { Origin: "not a url" }))).toBe(403);
  });

  it("is not moved by X-Forwarded-Host", () => {
    expect(refusal(post(`${OWN}/x`, { Origin: SIBLING, "X-Forwarded-Host": "second-tenant.fisqua.test" }))).toBe(403);
    expect(refusal(post(`${OWN}/x`, { Origin: OWN, "X-Forwarded-Host": "second-tenant.fisqua.test" }))).toBeNull();
  });

  it("refuses a host the Worker does not serve, even when Origin matches it", () => {
    expect(refusal(post("https://evil.example/x", { Origin: "https://evil.example" }))).toBe(403);
    expect(refusal(post("https://fisqua.test/x", { Origin: "https://fisqua.test" }))).toBe(403);
  });

  it("holds to the configured public host suffix where one is set", () => {
    const env = { PUBLIC_HOST_SUFFIX: ".fisqua.org" };
    expect(refusal(post(`${OWN}/x`, { Origin: OWN }), env)).toBe(403);
    expect(refusal(post("https://ahr.fisqua.org/x", { Origin: "https://ahr.fisqua.org" }), env)).toBeNull();
    expect(refusal(post("https://catalogacion.zasqua.org/x", { Origin: "https://catalogacion.zasqua.org" }), env)).toBeNull();
    expect(isServedHost("ahr.staging.fisqua.org", {})).toBe(true);
  });
});

// @version v0.8.0
