/**
 * Tests — operator index redirect
 *
 * Pins the fix for the bare `/operator` route: the `_operator` layout
 * (`app/routes.ts`) used to register only path-specific children
 * (`operator/tenants`, `.../new`, `.../:slug`, `.../:slug/login-as`),
 * so hitting the prefix on its own fell through to React Router's
 * no-match handling. `app/routes/_operator._index.tsx` closes that gap
 * with a bare loader-redirect, mirroring the existing
 * `_auth.admin.cataloguing._index.tsx` pattern (a redirect-only loader
 * with no request/context dependency, so it can be invoked directly
 * with no arguments).
 *
 * The `operatorAuthMiddleware` gate that runs on every request in this
 * route family (including this one, since it is a child of the
 * `_operator` layout) is covered separately by
 * `tests/operator/operator-layout.test.ts`; this suite only pins the
 * redirect target.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";

describe("operator index redirect", () => {
  it("redirects / operator to /operator/tenants", async () => {
    const { loader } = await import("../../app/routes/_operator._index");
    const result = loader() as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/operator/tenants");
  });
});

// @version v0.6.0
