/**
 * Tests — the Worker-wide same-origin check for state-changing requests
 *
 * `isCrossOriginSessionWrite` refuses a state-changing request that
 * carries the `__session` cookie unless its `Origin` is the origin of
 * the request's own URL; `isCrossOriginLoginPost` applies the same
 * `Origin` requirement, without a cookie, to the login route alone. This
 * suite pins both: what passes, what is refused, that the cookie is
 * found by exact name, that `X-Forwarded-Host` and `Host` change
 * nothing, and that variant spellings of `/login` are still caught.
 * Every host here is a test host.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import {
  isCrossOriginLoginPost,
  isCrossOriginSessionWrite,
} from "../../app/lib/same-origin.server";

const OWN = "https://neogranadina.fisqua.test";
const SIBLING = "https://second-tenant.fisqua.test";
const SESSION = "__session=signed-value";

function req(
  url: string,
  headers: Record<string, string> = {},
  method = "POST",
): Request {
  return new Request(url, { method, headers });
}

describe("isCrossOriginSessionWrite", () => {
  it("passes a same-origin write that carries the session cookie", () => {
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: SESSION, Origin: OWN }))).toBe(false);
  });

  it("refuses a cross-origin write that carries the session cookie", () => {
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: SESSION, Origin: SIBLING }))).toBe(true);
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: SESSION, Origin: "https://evil.example" }))).toBe(true);
    // Another scheme or port is another origin.
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: SESSION, Origin: "http://neogranadina.fisqua.test" }))).toBe(true);
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: SESSION, Origin: `${OWN}:8443` }))).toBe(true);
  });

  it("refuses a write with the session cookie and a missing or null Origin", () => {
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: SESSION }))).toBe(true);
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: SESSION, Origin: "null" }))).toBe(true);
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: SESSION, Origin: "" }))).toBe(true);
  });

  it("refuses every state-changing method, not only POST", () => {
    for (const method of ["PUT", "PATCH", "DELETE", "post"]) {
      expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments/1`, { Cookie: SESSION, Origin: SIBLING }, method))).toBe(true);
    }
  });

  it("passes a request without the session cookie, whatever its Origin", () => {
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`))).toBe(false);
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Origin: SIBLING }))).toBe(false);
    expect(
      isCrossOriginSessionWrite(
        req(`${OWN}/api/capture/v1/manifests`, { Authorization: "Bearer scanner-token" }),
      ),
    ).toBe(false);
  });

  it("passes GET, HEAD and OPTIONS with the session cookie", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isCrossOriginSessionWrite(req(`${OWN}/projects`, { Cookie: SESSION, Origin: SIBLING }, method))).toBe(false);
      expect(isCrossOriginSessionWrite(req(`${OWN}/projects`, { Cookie: SESSION }, method))).toBe(false);
    }
  });

  it("is not moved by a spoofed X-Forwarded-Host or Host", () => {
    expect(
      isCrossOriginSessionWrite(
        req(`${OWN}/api/comments`, {
          Cookie: SESSION,
          Origin: SIBLING,
          "X-Forwarded-Host": "second-tenant.fisqua.test",
        }),
      ),
    ).toBe(true);
    expect(
      isCrossOriginSessionWrite(
        req(`${OWN}/api/comments`, {
          Cookie: SESSION,
          Origin: SIBLING,
          Host: "second-tenant.fisqua.test",
        }),
      ),
    ).toBe(true);
    expect(
      isCrossOriginSessionWrite(
        req(`${OWN}/api/comments`, {
          Cookie: SESSION,
          Origin: OWN,
          "X-Forwarded-Host": "second-tenant.fisqua.test",
        }),
      ),
    ).toBe(false);
  });

  it("finds __session among other cookies", () => {
    const cookie = "theme=dark; __session=signed-value; lang=es";
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: cookie, Origin: SIBLING }))).toBe(true);
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: "a=1;__session=x", Origin: SIBLING }))).toBe(true);
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: cookie, Origin: OWN }))).toBe(false);
  });

  it("does not mistake x__session, or __session inside a value, for the session cookie", () => {
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: "x__session=abc", Origin: SIBLING }))).toBe(false);
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: "__session_old=abc", Origin: SIBLING }))).toBe(false);
    expect(isCrossOriginSessionWrite(req(`${OWN}/api/comments`, { Cookie: "note=__session=abc", Origin: SIBLING }))).toBe(false);
  });
});

describe("isCrossOriginLoginPost", () => {
  it("refuses a cross-site, missing or null Origin on a POST to /login", () => {
    expect(isCrossOriginLoginPost(req(`${OWN}/login`, { Origin: "https://evil.example" }))).toBe(true);
    expect(isCrossOriginLoginPost(req(`${OWN}/login`, { Origin: SIBLING }))).toBe(true);
    expect(isCrossOriginLoginPost(req(`${OWN}/login`))).toBe(true);
    expect(isCrossOriginLoginPost(req(`${OWN}/login`, { Origin: "null" }))).toBe(true);
  });

  it("passes a same-origin POST to /login, and GET from anywhere", () => {
    expect(isCrossOriginLoginPost(req(`${OWN}/login`, { Origin: OWN }))).toBe(false);
    expect(isCrossOriginLoginPost(req(`${OWN}/login`, { Origin: SIBLING }, "GET"))).toBe(false);
  });

  it("catches the spellings React Router would also route to the login action", () => {
    for (const path of ["/login/", "/LOGIN", "/Login.data", "/login.data", "/l%6Fgin"]) {
      expect(isCrossOriginLoginPost(req(`${OWN}${path}`, { Origin: SIBLING }))).toBe(true);
    }
    expect(isCrossOriginLoginPost(req(`${OWN}/login?index`, { Origin: SIBLING }, "PUT"))).toBe(true);
  });

  it("leaves every other path to the session rule", () => {
    expect(isCrossOriginLoginPost(req(`${OWN}/`, { Origin: SIBLING }))).toBe(false);
    expect(isCrossOriginLoginPost(req(`${OWN}/login-help`, { Origin: SIBLING }))).toBe(false);
    expect(isCrossOriginLoginPost(req(`${OWN}/auth/logout`, { Origin: SIBLING }))).toBe(false);
  });
});

// @version v0.8.0
