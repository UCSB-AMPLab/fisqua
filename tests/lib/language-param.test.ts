/**
 * Tests — removing `?lang=` from the settings page URL
 *
 * This suite pins `withoutLanguageParam`, which the settings page uses
 * to take `?lang=` out of its URL when the user picks a language there.
 * Left in place, the parameter would outrank the choice on every later
 * request from that page (revalidation and reload), because the i18next
 * middleware treats `?lang=` as an explicit choice.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { withoutLanguageParam } from "../../app/lib/language-param";

describe("withoutLanguageParam", () => {
  it("removes lang and keeps the other parameters", () => {
    expect(withoutLanguageParam("?lang=en&tab=2")).toBe("?tab=2");
  });

  it("returns an empty search when lang was the only parameter", () => {
    expect(withoutLanguageParam("?lang=en")).toBe("");
  });

  it("returns null when there is no lang parameter", () => {
    expect(withoutLanguageParam("?tab=2")).toBeNull();
    expect(withoutLanguageParam("")).toBeNull();
  });
});

// @version v0.9.0
