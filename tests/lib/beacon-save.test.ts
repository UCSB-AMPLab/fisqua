/**
 * Tests — beacon save helpers
 *
 * This suite is the pure-helper regression net for `shouldSendBeacon`,
 * `buildDescriptionBeaconBody`, and `buildEntriesBeaconBody`. These
 * helpers back the editor's beacon-on-navigation flush that prevents
 * in-app navigation from discarding in-flight saves. No RTL, no
 * jsdom, no `navigator.sendBeacon` mocking — the helpers are pure,
 * and the size-guard boundary plus Blob shape is what genuinely
 * needs to be pinned.
 *
 * The strict-less-than guard at exactly `BEACON_MAX_BYTES` is the
 * decided semantic (see `app/lib/beacon-save.ts` header): one
 * symbolic byte of headroom keeps the boundary deterministic.
 *
 * @version v0.4.1
 */
import { describe, it, expect } from "vitest";
import {
  BEACON_MAX_BYTES,
  shouldSendBeacon,
  buildDescriptionBeaconBody,
  buildEntriesBeaconBody,
} from "../../app/lib/beacon-save";

describe("shouldSendBeacon", () => {
  it("returns true for a small payload", () => {
    expect(shouldSendBeacon(1024)).toBe(true);
  });

  it("returns false at exactly BEACON_MAX_BYTES (strict less-than guard)", () => {
    expect(shouldSendBeacon(BEACON_MAX_BYTES)).toBe(false);
  });

  it("returns true just below BEACON_MAX_BYTES", () => {
    expect(shouldSendBeacon(BEACON_MAX_BYTES - 1)).toBe(true);
  });

  it("returns false above 60 KiB", () => {
    expect(shouldSendBeacon(70 * 1024)).toBe(false);
  });

  it("treats zero-byte payloads as sendable (defensive)", () => {
    // sendBeacon will happily accept an empty body; the helper does
    // not gate on payload non-emptiness because the call sites build
    // their own guards (e.g. only firing when hasUnsaved is true).
    expect(shouldSendBeacon(0)).toBe(true);
  });
});

describe("buildDescriptionBeaconBody", () => {
  it("returns a Blob tagged application/json", () => {
    const blob = buildDescriptionBeaconBody("entry-1", { translatedTitle: "x" });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");
  });

  it("payload roundtrips: parsed body contains entryId and fields", async () => {
    const blob = buildDescriptionBeaconBody("entry-1", {
      translatedTitle: "Carta de venta",
      language: "es",
    });
    const text = await blob.text();
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      entryId: "entry-1",
      fields: {
        translatedTitle: "Carta de venta",
        language: "es",
      },
    });
  });

  it("preserves null and empty-string field values verbatim", async () => {
    const blob = buildDescriptionBeaconBody("e2", {
      translatedTitle: null,
      language: "",
    });
    const text = await blob.text();
    const parsed = JSON.parse(text);
    expect(parsed.fields).toEqual({
      translatedTitle: null,
      language: "",
    });
  });
});

describe("buildEntriesBeaconBody", () => {
  it("returns a FormData with volumeId and serialised entries", () => {
    const entries = [{ id: "e1", startPage: 1 }];
    const fd = buildEntriesBeaconBody("vol-1", entries);
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get("volumeId")).toBe("vol-1");
    expect(fd.get("entries")).toBe(JSON.stringify(entries));
  });

  it("serialises an empty entries array as '[]', not null or undefined", () => {
    const fd = buildEntriesBeaconBody("vol-2", []);
    expect(fd.get("entries")).toBe("[]");
  });
});

/* @version v0.4.1 */
