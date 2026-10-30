/**
 * Tests — locale-aware date / number formatting
 *
 * This suite pins the three shared formatters that back every
 * user-facing date and number rendering: `relativeTime`
 * ("hace 1 hora" / "1 hour ago"), `formatDate` ("3 de julio de 1593" /
 * "July 3, 1593"), and `formatNumber` (locale-appropriate thousands
 * grouping). All three are pure wrappers over
 * `Intl.RelativeTimeFormat`, `Intl.DateTimeFormat`, and
 * `Intl.NumberFormat`, and each takes the active UI language as a
 * required argument.
 *
 * The contract under test is that the language argument — not a
 * module-level constant — decides the output. An earlier revision of
 * this suite asserted Spanish output unconditionally, which encoded
 * "always Colombian Spanish, for every user" as the intended
 * behaviour and made the English half of a bilingual app untestable.
 * Every assertion below is therefore run against both languages: the
 * same timestamp and the same number, formatted twice, must differ in
 * exactly the ways the two locales differ.
 *
 * Cases also pin the null-input contract (`relativeTime` returns the
 * U+2014 em dash for null in either language so the UI renders a
 * visible placeholder rather than "null" or "undefined"), the
 * relative-time bucketing (minutes / hours / days as the Intl
 * implementation decides), the language-narrowing helper that maps a
 * raw i18next language string onto the app's two-value union, and the
 * pre-1600 date round-trip (the cataloguer's corpus runs back to the
 * 1500s, so date helpers can't assume the Unix epoch is the earliest
 * reasonable input).
 *
 * The date formatters also take the reader's time zone. One instant
 * just after UTC midnight is formatted in Los Angeles, Bogotá and
 * Tokyo and must land on each zone's own calendar day, with
 * `America/Los_Angeles` when no zone is passed. `requestTimeZone`
 * reads the `tz` cookie a request carries and must accept only a zone
 * `Intl` accepts, falling back to `America/Los_Angeles` otherwise.
 * Every date expectation names its zone or relies on that default, so
 * the suite passes whatever zone the process running it is in.
 *
 * @version v0.8.0
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  relativeTime,
  formatDate,
  formatDateTime,
  formatNumber,
  requestTimeZone,
  toLanguage,
} from "../app/lib/format";

// 2026-10-26T04:46:08.454Z: still 25 October in Los Angeles (21:46)
// and Bogotá (23:46), already 26 October in Tokyo (13:46).
const NEAR_MIDNIGHT = 1792989968454;

function withCookie(cookie: string | null): Request {
  return new Request("https://fisqua.test/", {
    headers: cookie === null ? {} : { Cookie: cookie },
  });
}

describe("locale-aware formatting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("relativeTime", () => {
    it("returns a dash for null input in either language", () => {
      expect(relativeTime(null, "es")).toBe("—");
      expect(relativeTime(null, "en")).toBe("—");
    });

    it("buckets an hour-old timestamp to hours in both languages", () => {
      vi.useFakeTimers();
      const oneHourAgo = Date.now() - 3600000;
      expect(relativeTime(oneHourAgo, "es")).toMatch(/hace 1 hora/);
      expect(relativeTime(oneHourAgo, "en")).toMatch(/1 hour ago/);
    });

    it("buckets a minutes-old timestamp to minutes in both languages", () => {
      vi.useFakeTimers();
      const fiveMinutesAgo = Date.now() - 5 * 60000;
      expect(relativeTime(fiveMinutesAgo, "es")).toMatch(/hace 5 minutos/);
      expect(relativeTime(fiveMinutesAgo, "en")).toMatch(/5 minutes ago/);
    });

    it("buckets a days-old timestamp to days in both languages", () => {
      vi.useFakeTimers();
      const threeDaysAgo = Date.now() - 3 * 86400000;
      expect(relativeTime(threeDaysAgo, "es")).toMatch(/hace 3 días/);
      expect(relativeTime(threeDaysAgo, "en")).toMatch(/3 days ago/);
    });

    it("collapses a just-now timestamp to the second bucket", () => {
      vi.useFakeTimers();
      const now = Date.now();
      expect(relativeTime(now - 500, "es")).toMatch(/ahora/);
      expect(relativeTime(now - 500, "en")).toMatch(/now/);
    });

    it("measures from an explicit reference time, whatever the clock says", () => {
      const reference = 1792989968454;
      const stamp = reference - 59 * 60000;
      vi.useFakeTimers();
      vi.setSystemTime(reference);
      const atReference = relativeTime(stamp, "en", reference);
      // Two minutes later the clock reads "1 hour ago"; the reference
      // time still gives "59 minutes ago".
      vi.setSystemTime(reference + 2 * 60000);
      expect(relativeTime(stamp, "en", reference)).toBe(atReference);
      expect(atReference).toBe("59 minutes ago");
      expect(relativeTime(stamp, "es", reference)).toBe("hace 59 minutos");
      expect(relativeTime(stamp, "en")).toBe("1 hour ago");
    });

    it("reads the clock when no reference time is passed", () => {
      vi.useFakeTimers();
      const stamp = Date.now() - 5 * 60000;
      expect(relativeTime(stamp, "en")).toBe(relativeTime(stamp, "en", Date.now()));
    });
  });

  describe("formatDate", () => {
    it("renders the same pre-1600 timestamp in each language's long form", () => {
      // July 3, 1593 — well before the Unix epoch, and inside the
      // period the catalogued corpus actually covers.
      const timestamp = Date.UTC(1593, 6, 3, 20);
      expect(formatDate(timestamp, "es")).toMatch(/3 de julio de 1593/);
      expect(formatDate(timestamp, "en")).toMatch(/July 3, 1593/);
    });

    it("produces different output per language for the same timestamp", () => {
      const timestamp = Date.UTC(2026, 7, 12, 20);
      expect(formatDate(timestamp, "es")).not.toBe(
        formatDate(timestamp, "en"),
      );
      expect(formatDate(timestamp, "es")).toMatch(/12 de agosto de 2026/);
      expect(formatDate(timestamp, "en")).toMatch(/August 12, 2026/);
    });

    it("puts a timestamp near UTC midnight on the given zone's calendar", () => {
      expect(formatDate(NEAR_MIDNIGHT, "en", "America/Los_Angeles")).toBe(
        "October 25, 2026",
      );
      expect(formatDate(NEAR_MIDNIGHT, "en", "America/Bogota")).toBe(
        "October 25, 2026",
      );
      expect(formatDate(NEAR_MIDNIGHT, "en", "Asia/Tokyo")).toBe(
        "October 26, 2026",
      );
      expect(formatDate(NEAR_MIDNIGHT, "es", "America/Bogota")).toMatch(
        /25 de octubre de 2026/,
      );
      expect(formatDate(NEAR_MIDNIGHT, "es", "Asia/Tokyo")).toMatch(
        /26 de octubre de 2026/,
      );
    });

    it("uses America/Los_Angeles when no zone is passed", () => {
      expect(formatDate(NEAR_MIDNIGHT, "es")).toMatch(/25 de octubre de 2026/);
      expect(formatDate(NEAR_MIDNIGHT, "en")).toBe("October 25, 2026");
    });
  });

  describe("formatDateTime", () => {
    it("shows the given zone's day and time of day", () => {
      expect(
        formatDateTime(NEAR_MIDNIGHT, "en", "America/Los_Angeles"),
      ).toMatch(/Oct 25, 2026, 9:46\sPM/);
      expect(formatDateTime(NEAR_MIDNIGHT, "en", "America/Bogota")).toMatch(
        /Oct 25, 2026, 11:46\sPM/,
      );
      expect(formatDateTime(NEAR_MIDNIGHT, "en", "Asia/Tokyo")).toMatch(
        /Oct 26, 2026, 1:46\sPM/,
      );
      expect(formatDateTime(NEAR_MIDNIGHT, "es", "Asia/Tokyo")).toMatch(
        /^26\/10\/2026, 1:46/,
      );
    });

    it("uses America/Los_Angeles when no zone is passed", () => {
      expect(formatDateTime(NEAR_MIDNIGHT, "es")).toMatch(/^25\/10\/2026, 9:46/);
      expect(formatDateTime(NEAR_MIDNIGHT, "en")).toMatch(
        /Oct 25, 2026, 9:46\sPM/,
      );
    });
  });

  describe("requestTimeZone", () => {
    it("reads a valid zone from the tz cookie, encoded or not", () => {
      expect(requestTimeZone(withCookie("tz=America%2FBogota"))).toBe(
        "America/Bogota",
      );
      expect(requestTimeZone(withCookie("tz=Asia/Tokyo"))).toBe("Asia/Tokyo");
      expect(requestTimeZone(withCookie("tz=UTC"))).toBe("UTC");
    });

    it("finds tz among other cookies", () => {
      expect(
        requestTimeZone(
          withCookie("__session=abc; tz=Asia%2FTokyo; lng=es"),
        ),
      ).toBe("Asia/Tokyo");
    });

    it("falls back to America/Los_Angeles without a cookie", () => {
      expect(requestTimeZone(withCookie(null))).toBe("America/Los_Angeles");
      expect(requestTimeZone(withCookie("__session=abc"))).toBe(
        "America/Los_Angeles",
      );
    });

    it("falls back to America/Los_Angeles for a zone Intl rejects", () => {
      expect(requestTimeZone(withCookie("tz=Not%2FA_Zone"))).toBe(
        "America/Los_Angeles",
      );
      expect(requestTimeZone(withCookie("tz="))).toBe("America/Los_Angeles");
      expect(requestTimeZone(withCookie("tz=%E0%A4%A"))).toBe(
        "America/Los_Angeles",
      );
      expect(
        requestTimeZone(withCookie(`tz=${"A".repeat(200)}`)),
      ).toBe("America/Los_Angeles");
    });

    it("does not read a cookie whose name only ends in tz", () => {
      expect(requestTimeZone(withCookie("xtz=Asia%2FTokyo"))).toBe(
        "America/Los_Angeles",
      );
    });
  });

  describe("formatNumber", () => {
    it("groups thousands with a period in Spanish and a comma in English", () => {
      expect(formatNumber(20545, "es")).toBe("20.545");
      expect(formatNumber(20545, "en")).toBe("20,545");
    });

    it("groups larger magnitudes consistently in both languages", () => {
      expect(formatNumber(1234567, "es")).toBe("1.234.567");
      expect(formatNumber(1234567, "en")).toBe("1,234,567");
    });
  });

  describe("toLanguage", () => {
    it("narrows region-tagged and bare language strings onto the union", () => {
      expect(toLanguage("en")).toBe("en");
      expect(toLanguage("en-US")).toBe("en");
      expect(toLanguage("en-GB")).toBe("en");
      expect(toLanguage("es")).toBe("es");
      expect(toLanguage("es-CO")).toBe("es");
    });

    it("falls back to Spanish for unknown or absent languages", () => {
      // Mirrors the middleware's `fallbackLanguage: "es"`.
      expect(toLanguage(undefined)).toBe("es");
      expect(toLanguage(null)).toBe("es");
      expect(toLanguage("fr")).toBe("es");
    });
  });
});

/* @version v0.8.0 */
