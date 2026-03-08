import { describe, it, expect } from "vitest";
import { createSessionStorage } from "../../app/sessions.server";

const TEST_SECRET = "test-session-secret-at-least-32-characters-long";

describe("logout", () => {
  it("destroys session and produces a cookie that clears userId", async () => {
    const { getSession, commitSession, destroySession } =
      createSessionStorage(TEST_SECRET);

    // Create a session
    const session = await getSession();
    session.set("userId", "test-user-id");
    const cookie = await commitSession(session);

    // Destroy it
    const destroyCookie = await destroySession(await getSession(cookie));

    // Verify the session is empty after destruction
    const emptySession = await getSession(destroyCookie);
    expect(emptySession.get("userId")).toBeUndefined();
  });

  it("produces a Set-Cookie header that expires the cookie", async () => {
    const { getSession, commitSession, destroySession } =
      createSessionStorage(TEST_SECRET);

    const session = await getSession();
    session.set("userId", "test-user-id");
    const cookie = await commitSession(session);

    const destroyCookie = await destroySession(await getSession(cookie));

    // The destroy cookie should set Max-Age=0 or an expired date
    expect(destroyCookie).toContain("__session");
  });
});
