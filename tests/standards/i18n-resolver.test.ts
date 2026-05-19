/**
 * Tests — Standard-Aware i18n Resolver (tStd)
 *
 * This suite is the unit-coverage net for `app/lib/i18n/standard-aware.ts`. It asserts that
 * `tStd(t, key, standard, vars?)` returns the per-standard override
 * when present, falls back to the bare key value when no override
 * exists, works for both EN and ES bundles, and
 * passes interpolation variables to BOTH inner and outer t() calls
 * (Pitfall 2: i18next's defaultValue is a literal string, not a
 * key — variables must flow to both calls).
 *
 * Mocks the TFunction directly — no real i18next setup is needed
 * because the resolver is a pure shim over the t() contract. The
 * mocks mirror i18next's own resolution + defaultValue semantics so
 * the test exercises the actual behavior we depend on.
 *
 * Per-file vitest cadence only (memory `feedback_no_full_test_suite`).
 *
 * @version v0.4.0
 */

import { describe, it, expect, vi } from "vitest";
import { tStd } from "../../app/lib/i18n/standard-aware";

/**
 * Mirrors i18next's resolution semantics: if the key exists in the
 * map, return its value; else if `opts.defaultValue` is a string,
 * return that; else echo the key (i18next's last-resort fallback).
 */
function makeTFunction(map: Record<string, string>) {
  return vi.fn((key: string, opts?: any) => {
    if (map[key] !== undefined) return map[key];
    if (opts && typeof opts.defaultValue === "string") return opts.defaultValue;
    return key;
  }) as any;
}

describe("tStd resolver", () => {
  it("returns the per-standard override when it exists (EN)", () => {
    const t = makeTFunction({
      "fields.title": "Title",
      "fields.title.dacs": "Title (DACS variant)",
    });
    expect(tStd(t, "fields.title", "dacs")).toBe("Title (DACS variant)");
  });

  it("falls back to the bare key value when no override (EN)", () => {
    const t = makeTFunction({
      "fields.title": "Title",
    });
    expect(tStd(t, "fields.title", "isadg")).toBe("Title");
  });

  it("falls back to the bare key value (ES — Spanish bundle)", () => {
    const t = makeTFunction({
      "fields.title": "Título",
    });
    expect(tStd(t, "fields.title", "isadg")).toBe("Título");
  });

  it("returns ES override when present (ES bundle)", () => {
    const t = makeTFunction({
      "fields.title": "Título",
      "fields.title.rad": "Título propio",
    });
    expect(tStd(t, "fields.title", "rad")).toBe("Título propio");
  });

  it("passes interpolation variables to the override call (Pitfall 2)", () => {
    const t = vi.fn((key: string, opts?: any) => {
      if (key === "fields.placeholder.dacs" && opts?.name)
        return `DACS ${opts.name}`;
      if (key === "fields.placeholder" && opts?.name)
        return `Default ${opts.name}`;
      if (opts?.defaultValue !== undefined) return opts.defaultValue;
      return key;
    }) as any;
    // Override path with vars — outer call must pick up the variable.
    expect(tStd(t, "fields.placeholder", "dacs", { name: "X" })).toBe("DACS X");
    // Verify the override call carried vars. WR-05: when an
    // override exists, only ONE t() call is made (the override
    // call). The bare-key fallback is not invoked.
    expect(t).toHaveBeenCalledWith(
      "fields.placeholder.dacs",
      expect.objectContaining({ name: "X" }),
    );
  });

  it("passes interpolation variables to the fallback call when no override (Pitfall 2)", () => {
    const t = vi.fn((key: string, opts?: any) => {
      // No override key at all in this map.
      if (key === "fields.placeholder" && opts?.name)
        return `Default ${opts.name}`;
      if (opts?.defaultValue !== undefined) return opts.defaultValue;
      return key;
    }) as any;
    expect(tStd(t, "fields.placeholder", "isadg", { name: "Y" })).toBe(
      "Default Y",
    );
    // The bare-key fallback receives vars.
    expect(t).toHaveBeenCalledWith("fields.placeholder", { name: "Y" });
  });

  it("makes only one t() call when an override exists (WR-05)", () => {
    const t = makeTFunction({
      "fields.title": "Title",
      "fields.title.dacs": "DACS title",
    });
    tStd(t, "fields.title", "dacs");
    expect(t).toHaveBeenCalledTimes(1);
  });

  it("makes two t() calls when no override exists (WR-05)", () => {
    const t = makeTFunction({
      "fields.title": "Title",
    });
    tStd(t, "fields.title", "isadg");
    expect(t).toHaveBeenCalledTimes(2);
  });
});

/* @version v0.4.0 */
