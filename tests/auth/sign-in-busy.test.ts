/**
 * Tests — the sign-in form when D1 is overloaded
 *
 * This suite drives the /login action through the i18next middleware,
 * as the router does, with `generateMagicLink` mocked to throw. A D1
 * overload refusal, bare or wrapped in drizzle's `DrizzleQueryError`,
 * becomes a 503 carrying the translated `auth:error.sign_in_busy`
 * message, which the form renders as given. Any other error leaves
 * the action unchanged, so the router's error handling still sees it.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { i18nextMiddleware } from "../../app/middleware/i18next";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { requestTenantContext } from "../../app/context";

vi.mock("../../app/lib/auth.server", () => ({
  generateMagicLink: vi.fn(),
}));

import { generateMagicLink } from "../../app/lib/auth.server";

const SIGN_IN = "https://neogranadina.fisqua.test/login";

async function submit(lang: "en" | "es", heldTenant?: Promise<any>): Promise<any> {
  const body = new FormData();
  body.set("email", "scholar@example.com");
  const request = new Request(`${SIGN_IN}?lang=${lang}`, { method: "POST", body });
  const context = new RouterContextProvider();
  if (heldTenant) {
    heldTenant.catch(() => {});
    context.set(requestTenantContext, heldTenant);
  }
  (context as any).cloudflare = {
    env: { ...env, SESSION_SECRET: "test-session-secret", RESEND_API_KEY: "test-resend-key" },
  };
  const { action } = await import("../../app/routes/login");
  let outcome: { result?: any; error?: unknown } = {};
  await i18nextMiddleware({ request, context, params: {} } as any, async () => {
    try {
      outcome.result = await action({ request, context, params: {} } as any);
    } catch (error) {
      outcome.error = error;
    }
    return new Response("ok");
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

describe("sign-in action under D1 overload", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.mocked(generateMagicLink).mockReset();
  });

  it("answers 503 with the busy message in English", async () => {
    vi.mocked(generateMagicLink).mockRejectedValue(
      new DrizzleQueryError("insert into magic_links", [], new Error("D1 DB is overloaded")),
    );
    const response = await submit("en");
    expect(response.init?.status).toBe(503);
    expect(response.data).toEqual({
      error: "Your sign-in link couldn't be sent just now. Try again in a few seconds.",
      success: false,
    });
  });

  it("answers 503 with the busy message in Spanish", async () => {
    vi.mocked(generateMagicLink).mockRejectedValue(new Error("D1_ERROR: Too many requests [code: 7429]"));
    const response = await submit("es");
    expect(response.init?.status).toBe(503);
    expect(response.data.error).toBe(
      "No se pudo enviar el enlace de acceso. Intenta de nuevo en unos segundos.",
    );
  });

  it("answers 503 when the workspace lookup is refused as overloaded", async () => {
    vi.mocked(generateMagicLink).mockResolvedValue({ success: true });
    const refused = Promise.reject(
      new DrizzleQueryError("select from tenants", [], new Error("D1 DB is overloaded")),
    );
    const response = await submit("en", refused);
    expect(response.init?.status).toBe(503);
    expect(response.data.error).toBe(
      "Your sign-in link couldn't be sent just now. Try again in a few seconds.",
    );
    expect(generateMagicLink).not.toHaveBeenCalled();
  });

  it("lets any other error through unchanged", async () => {
    const err = new Error("D1_ERROR: no such table: magic_links");
    vi.mocked(generateMagicLink).mockRejectedValue(err);
    await expect(submit("en")).rejects.toBe(err);
  });
});

// @version v0.9.0
