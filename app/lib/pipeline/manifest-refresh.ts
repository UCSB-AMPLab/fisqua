/**
 * Media Pipeline — Manifest Attribution Refresh, the Text
 *
 * This module deals with rewriting three top-level fields of a published
 * IIIF manifest, `requiredStatement`, `provider` and `rights`, and
 * leaving every other byte of it as it is. The values come from
 * `resolveManifestInputs` (`manifest-inputs.ts`), the source the media
 * pipeline builds its manifests from; the refresh run
 * (`manifest-refresh-run.server.ts`) reads each manifest, asks this
 * module what differs and, when something does, writes the text this
 * module returns.
 *
 * `refreshValuesOf(inputs)` takes the three values from a manifest
 * block: `rights`, `required_statement` (written `requiredStatement`)
 * and `provider`. A null value means the field is left out, as the
 * runner leaves a null rights or required statement out.
 *
 * `differingFields(doc, values)` lists the fields whose value in the
 * parsed manifest is not the computed one, in JSON terms
 * (`firstDifference` in `json-difference.ts`, the comparison
 * publishing uses: key order does not count). A field whose computed
 * value is null differs when the manifest has it at all.
 *
 * `scanTopLevel(text)` reads the top level of the manifest text without
 * parsing its values: where each member starts and ends, where its
 * value starts, and the text between members and between a key and its
 * value. `spliceRefreshFields(text, values)` uses it to replace the
 * three values in place. A member keeps its position and its key's text;
 * only its value is written anew. A field the manifest lacks is
 * inserted after the nearest field that comes before it in the order
 * `expectedHeldManifest` writes (`HELD_MANIFEST_ORDER`), or first when
 * none is present; a field whose value is null is removed with one of
 * its separators. Everything outside the three values is the input's
 * text, byte for byte.
 *
 * The new values are written in the style of the text around them: the
 * separator between members and the one between a key and its value are
 * read from the top level (the published manifests use `", "` and
 * `": "`, Python's defaults), and characters outside ASCII are written
 * as they are unless the text escapes them and holds none raw. A
 * manifest whose top level spreads over several lines, or uses more
 * than one separator style, or names a key twice, is refused with
 * `ManifestSpliceError` rather than written in a style it does not use.
 *
 * `checkSplice(before, after, values)` is the check made before any
 * write: the new text parses, holds the same top-level keys in the same
 * order (apart from the three), every other field equals the old one,
 * and the three equal the computed values. It names the first failure.
 *
 * `manifestKeyOf(url, baseUrl, tenantSlug)` gives the object key behind
 * a description's manifest URL: the URL with the federation's manifest
 * address removed. Only a key of the form
 * `iiif/{reference}/manifest.json`, or the same under the tenant's
 * `{slug}/`, is accepted, and only when every segment is made of ASCII
 * letters, digits, `-`, `_`, `.` and `~` and is neither `.` nor `..`
 * (`KEY_SEGMENT`). A URL outside the address, a key with any other
 * character or segment, and a key elsewhere in the bucket are refused
 * with the reason.
 *
 * Nothing here reads or writes storage, and nothing names an archive or
 * a site.
 *
 * @version v0.9.0
 */

import type { RunSpecManifest } from "./run-spec";
import { firstDifference } from "./json-difference";

export type RefreshField = "provider" | "rights" | "requiredStatement";

/** The three fields, in the order the splice handles them (their held-manifest order). */
export const REFRESH_FIELDS: readonly RefreshField[] = ["provider", "rights", "requiredStatement"];

/** The top-level order `expectedHeldManifest` writes a manifest in. */
export const HELD_MANIFEST_ORDER: readonly string[] = [
  "@context",
  "id",
  "type",
  "label",
  "behavior",
  "provider",
  "items",
  "rights",
  "requiredStatement",
  "homepage",
  "metadata",
  "summary",
  "seeAlso",
];

export type RefreshValues = Record<RefreshField, unknown | null>;

export function refreshValuesOf(inputs: RunSpecManifest): RefreshValues {
  return {
    provider: inputs.provider ?? null,
    rights: inputs.rights ?? null,
    requiredStatement: inputs.required_statement ?? null,
  };
}

function has(doc: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(doc, key);
}

/** The fields whose value in `doc` is not the computed one. */
export function differingFields(doc: Record<string, unknown>, values: RefreshValues): RefreshField[] {
  return REFRESH_FIELDS.filter((field) => {
    const value = values[field];
    if (value === null) return has(doc, field);
    return !has(doc, field) || firstDifference(doc[field], value) !== null;
  });
}

/** The three fields as a manifest holds them, absent ones as null. */
export function currentValuesOf(doc: Record<string, unknown>): RefreshValues {
  return {
    provider: has(doc, "provider") ? doc.provider : null,
    rights: has(doc, "rights") ? doc.rights : null,
    requiredStatement: has(doc, "requiredStatement") ? doc.requiredStatement : null,
  };
}

// ---------------------------------------------------------------------------
// Reading the top level
// ---------------------------------------------------------------------------

export type SpliceRefusal =
  | "not_json_object"
  | "duplicate_key"
  | "format_unsupported";

export class ManifestSpliceError extends Error {
  readonly code: SpliceRefusal;
  constructor(code: SpliceRefusal, message: string) {
    super(message);
    this.name = "ManifestSpliceError";
    this.code = code;
  }
}

export interface TopLevelMember {
  key: string;
  /** Index of the key's opening quote. */
  start: number;
  /** Index just past the key's closing quote. */
  keyEnd: number;
  valueStart: number;
  /** Index just past the value. */
  end: number;
}

export interface TopLevel {
  members: TopLevelMember[];
  /** Index just past the opening brace. */
  open: number;
  /** Index of the closing brace. */
  close: number;
}

const WS = new Set([" ", "\t", "\n", "\r"]);

function skipWs(text: string, i: number): number {
  while (i < text.length && WS.has(text[i])) i++;
  return i;
}

function refuse(message: string): never {
  throw new ManifestSpliceError("not_json_object", message);
}

/** Index just past the string starting at `i`. */
function skipString(text: string, i: number): number {
  if (text[i] !== '"') refuse(`Expected a string at ${i}`);
  i++;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  if (i >= text.length) refuse("Unterminated string");
  return i + 1;
}

/** Index just past the JSON value starting at `i`; the value is not validated beyond its extent. */
function skipValue(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return skipString(text, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    while (i < text.length) {
      const d = text[i];
      if (d === '"') {
        i = skipString(text, i);
        continue;
      }
      if (d === "{" || d === "[") depth++;
      else if (d === "}" || d === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    refuse("Unterminated value");
  }
  const start = i;
  while (i < text.length && !WS.has(text[i]) && text[i] !== "," && text[i] !== "}" && text[i] !== "]") i++;
  if (i === start) refuse(`Expected a value at ${start}`);
  return i;
}

export function scanTopLevel(text: string): TopLevel {
  let i = skipWs(text, 0);
  if (text[i] !== "{") refuse("The manifest is not a JSON object");
  const open = i + 1;
  i = skipWs(text, open);
  const members: TopLevelMember[] = [];
  if (text[i] !== "}") {
    for (;;) {
      const start = i;
      const keyEnd = skipString(text, i);
      const key = JSON.parse(text.slice(start, keyEnd)) as string;
      i = skipWs(text, keyEnd);
      if (text[i] !== ":") refuse(`Expected ':' at ${i}`);
      const valueStart = skipWs(text, i + 1);
      const end = skipValue(text, valueStart);
      members.push({ key, start, keyEnd, valueStart, end });
      i = skipWs(text, end);
      if (text[i] === ",") {
        i = skipWs(text, i + 1);
        continue;
      }
      if (text[i] === "}") break;
      refuse(`Expected ',' or '}' at ${i}`);
    }
  }
  const close = i;
  if (skipWs(text, close + 1) !== text.length) refuse("Text follows the manifest object");
  return { members, open, close };
}

// ---------------------------------------------------------------------------
// Writing values in the text's style
// ---------------------------------------------------------------------------

export interface TextStyle {
  /** Between members, and between items of a list. */
  itemSep: string;
  /** Between a key and its value. */
  keySep: string;
  /** Write characters outside ASCII as `\uXXXX`. */
  escapeNonAscii: boolean;
}

const MULTILINE = /[\n\r\t]/;

/** The style of a manifest's text, read from its top level. */
export function textStyleOf(text: string, top: TopLevel): TextStyle {
  const { members } = top;
  const keySeps = new Set(members.map((m) => text.slice(m.keyEnd, m.valueStart)));
  const itemSeps = new Set(members.slice(1).map((m, idx) => text.slice(members[idx].end, m.start)));
  const padding = members.length > 0
    ? text.slice(top.open, members[0].start) + text.slice(members[members.length - 1].end, top.close)
    : "";
  if (keySeps.size > 1 || itemSeps.size > 1) {
    throw new ManifestSpliceError("format_unsupported", "The manifest's top level uses more than one separator style");
  }
  const keySep = keySeps.size === 1 ? [...keySeps][0] : ": ";
  const itemSep = itemSeps.size === 1 ? [...itemSeps][0] : ", ";
  if (MULTILINE.test(keySep) || MULTILINE.test(itemSep) || MULTILINE.test(padding)) {
    throw new ManifestSpliceError("format_unsupported", "The manifest's top level spreads over several lines");
  }
  const rawNonAscii = /[^\x00-\x7f]/.test(text);
  const escaped = /\\u(00[89a-fA-F][0-9a-fA-F]|0[1-9a-fA-F][0-9a-fA-F]{2}|[1-9a-fA-F][0-9a-fA-F]{3})/.test(text);
  return { itemSep, keySep, escapeNonAscii: !rawNonAscii && escaped };
}

function stringLiteral(value: string, style: TextStyle): string {
  const json = JSON.stringify(value);
  if (!style.escapeNonAscii) return json;
  return json.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A JSON value written with the style's separators, keys in their insertion order. */
export function serializeInStyle(value: unknown, style: TextStyle): string {
  if (value === null) return "null";
  if (typeof value === "string") return stringLiteral(value, style);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("A manifest value cannot be a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((v) => serializeInStyle(v, style)).join(style.itemSep)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries
      .map(([k, v]) => `${stringLiteral(k, style)}${style.keySep}${serializeInStyle(v, style)}`)
      .join(style.itemSep)}}`;
  }
  throw new TypeError(`A manifest value cannot be of type ${typeof value}`);
}

// ---------------------------------------------------------------------------
// The splice
// ---------------------------------------------------------------------------

/**
 * The manifest text with the three fields set to `values`: replaced in
 * place, inserted where the held-manifest order puts them, or removed
 * when null. Throws `ManifestSpliceError` for text it will not rewrite.
 */
export function spliceRefreshFields(text: string, values: RefreshValues): string {
  const top = scanTopLevel(text);
  const seen = new Set<string>();
  for (const m of top.members) {
    if (seen.has(m.key)) {
      throw new ManifestSpliceError("duplicate_key", `The manifest names ${JSON.stringify(m.key)} twice`);
    }
    seen.add(m.key);
  }
  const style = textStyleOf(text, top);

  const { members } = top;
  const prefix = members.length > 0 ? text.slice(0, members[0].start) : text.slice(0, top.close);
  const suffix = members.length > 0 ? text.slice(members[members.length - 1].end) : text.slice(top.close);
  const parts: Array<{ key: string; raw: string }> = members.map((m) => ({
    key: m.key,
    raw: text.slice(m.start, m.end),
  }));

  for (const field of REFRESH_FIELDS) {
    const value = values[field];
    const at = parts.findIndex((p) => p.key === field);
    if (at >= 0) {
      if (value === null) {
        parts.splice(at, 1);
      } else {
        const m = members.find((mm) => mm.key === field) as TopLevelMember;
        parts[at] = { key: field, raw: text.slice(m.start, m.valueStart) + serializeInStyle(value, style) };
      }
      continue;
    }
    if (value === null) continue;
    const raw = `${stringLiteral(field, style)}${style.keySep}${serializeInStyle(value, style)}`;
    const order = HELD_MANIFEST_ORDER.indexOf(field);
    let anchor = -1;
    for (let j = order - 1; j >= 0 && anchor < 0; j--) {
      anchor = parts.findIndex((p) => p.key === HELD_MANIFEST_ORDER[j]);
    }
    parts.splice(anchor + 1, 0, { key: field, raw });
  }

  return prefix + parts.map((p) => p.raw).join(style.itemSep) + suffix;
}

/** The first way `after` is not `before` with the three fields set to `values`, or null. */
export function checkSplice(before: string, after: string, values: RefreshValues): string | null {
  let old: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    old = JSON.parse(before);
    next = JSON.parse(after);
  } catch {
    return "unparseable";
  }
  const isRefresh = (k: string) => (REFRESH_FIELDS as readonly string[]).includes(k);
  const oldKeys = Object.keys(old).filter((k) => !isRefresh(k));
  const newKeys = Object.keys(next).filter((k) => !isRefresh(k));
  if (oldKeys.join("\u0000") !== newKeys.join("\u0000")) return "key_order";
  for (const k of oldKeys) {
    const d = firstDifference(next[k], old[k], `$.${k}`);
    if (d !== null) return d;
  }
  const wrong = differingFields(next, values);
  return wrong.length > 0 ? `$.${wrong[0]}` : null;
}

// ---------------------------------------------------------------------------
// The object key
// ---------------------------------------------------------------------------

/**
 * One segment of an accepted key: ASCII letters, digits, `-`, `_`, `.`
 * and `~`, at least one. These are the unreserved characters of a URL
 * (RFC 3986 §2.3), the ones neither a URL parser nor the SigV4
 * canonical path changes or encodes. With `/` only between segments,
 * no empty, `.` or `..` segment, and nothing else allowed (no `%`, so no
 * escape a later decoding could turn into `/` or `.`; no backslash, no
 * control, space or non-ASCII character), the path that is signed and
 * sent is the key as written, and names the object the key names.
 */
const KEY_SEGMENT = /^[A-Za-z0-9._~-]+$/;

export type ManifestKeyRefusal = "outside_manifest_base" | "key_not_allowed" | "key_outside_iiif";

export function manifestKeyOf(
  url: string,
  baseUrl: string,
  tenantSlug: string,
): { key: string } | { refusal: ManifestKeyRefusal } {
  const base = baseUrl.replace(/\/+$/, "");
  if (!url.startsWith(base + "/")) return { refusal: "outside_manifest_base" };
  const key = url.slice(base.length + 1);
  const segments = key.split("/");
  if (!segments.every((segment) => KEY_SEGMENT.test(segment) && segment !== "." && segment !== "..")) {
    return { refusal: "key_not_allowed" };
  }
  const local =
    segments.length === 3 ? segments : segments.length === 4 && segments[0] === tenantSlug ? segments.slice(1) : null;
  if (local === null || local[0] !== "iiif" || local[2] !== "manifest.json") return { refusal: "key_outside_iiif" };
  return { key };
}

// @version v0.9.0
