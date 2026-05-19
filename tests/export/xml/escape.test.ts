/**
 * Tests — Shared XML Emit Helpers
 *
 * This suite pins the contract of `escapeXml`, `el(tag, text)`, and
 * `sanitiseRefForKey(ref)` factored out of `mets-builder.ts`. The
 * METS, EAD3, and Dublin Core builders all import from this module,
 * so the behaviours below are the regression surface that keeps
 * cross-emitter XML-injection holes closed and reference-code-
 * derived R2 keys safe.
 *
 * @version v0.4.0
 */

import { describe, it, expect } from "vitest";
import {
  escapeXml,
  el,
  sanitiseRefForKey,
} from "../../../app/lib/export/xml/escape";

describe("escapeXml", () => {
  it("escapes ampersand, angle brackets, and double quotes", () => {
    expect(escapeXml('<a&b"c>')).toBe("&lt;a&amp;b&quot;c&gt;");
  });

  // Apostrophe must escape to &apos; so single-quoted attribute
  // interpolations (XML permits them) cannot break document well-
  // formedness. Pins the full canonical XML escape set against
  // future refactor drift.
  it("escapes apostrophe to &apos;", () => {
    expect(escapeXml("a'b")).toBe("a&apos;b");
  });

  it("escapes the full set in one pass", () => {
    expect(escapeXml(`<a&b"c'd>`)).toBe("&lt;a&amp;b&quot;c&apos;d&gt;");
  });
});

describe("el", () => {
  it("emits a single element wrapping escaped, indented text", () => {
    expect(el("dc:title", "Hello")).toBe(
      "    <dc:title>Hello</dc:title>\n",
    );
  });

  it("returns empty string for null input", () => {
    expect(el("dc:title", null)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(el("dc:title", "")).toBe("");
  });

  it("trims surrounding whitespace before emitting", () => {
    expect(el("dc:title", "  trim me  ")).toBe(
      "    <dc:title>trim me</dc:title>\n",
    );
  });

  it("escapes XML-special characters in the body", () => {
    expect(el("dc:title", "<bad>")).toBe(
      "    <dc:title>&lt;bad&gt;</dc:title>\n",
    );
  });
});

describe("sanitiseRefForKey", () => {
  it("strips '?' and '#' from a reference code", () => {
    expect(sanitiseRefForKey("co-ahr-gob?abc#frag")).toBe(
      "co-ahr-gobabcfrag",
    );
  });

  // A reference code is sourced from descriptions.referenceCode, a
  // user-supplied D1 column with no character constraints. Without
  // this guard, a code containing `/` or `\` would split the R2 key
  // across segments, and `..` would survive as an upward traversal.
  it("strips forward slashes (path traversal)", () => {
    expect(sanitiseRefForKey("co-ahr/gob")).toBe("co-ahrgob");
  });

  it("strips back slashes", () => {
    expect(sanitiseRefForKey("co-ahr\\gob")).toBe("co-ahrgob");
  });

  it("strips '..' traversal segments", () => {
    expect(sanitiseRefForKey("..etc..passwd")).toBe("etcpasswd");
  });

  it("strips a combined adversarial input", () => {
    expect(sanitiseRefForKey("../co-ahr/gob?frag#hash")).toBe("co-ahrgobfraghash");
  });
});
