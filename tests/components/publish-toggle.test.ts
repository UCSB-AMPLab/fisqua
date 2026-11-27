/**
 * Tests — the publish toggle takes one submission at a time
 *
 * This suite pins that the publish toggle takes one submission at a time.
 * Each toggle moves the description's version on from the version it read
 * and answers with the versions it moved between, which the edit form
 * follows. A second submission while the first is in flight would
 * supersede the first's response although its write committed, and the
 * form could not follow that move. The toggle is therefore enabled only
 * while its fetcher is idle.
 *
 * `publishToggleEnabled` is the pure rule the button's `disabled`
 * follows; it is tested without rendering.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { publishToggleEnabled } from "../../app/components/descriptions/publish-toggle";

describe("publishToggleEnabled", () => {
  it("is enabled while the toggle's fetcher is idle", () => {
    expect(publishToggleEnabled("idle")).toBe(true);
  });

  it("is disabled while a toggle is submitting or its response is loading", () => {
    expect(publishToggleEnabled("submitting")).toBe(false);
    expect(publishToggleEnabled("loading")).toBe(false);
  });
});

// @version v0.9.0
