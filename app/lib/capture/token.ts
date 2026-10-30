/**
 * Capture Link — Scanner Tokens and Body Digests
 *
 * This module deals with the bearer token a Captua unit presents on the
 * capture link and with the digest that makes manifest delivery
 * idempotent, both as the Captua exchange contract defines them. It is
 * pure and runs in the Worker and in the operator's commands alike,
 * since both need the same hash: the command stores it, the Worker
 * looks the presented token up
 * by it.
 *
 * A token is 32 random bytes written as 64 lowercase hex characters
 * (`mintScannerToken`). Fisqua keeps only `hashScannerToken(token)`, the
 * SHA-256 of the token's 64 characters as UTF-8, in lowercase hex; the
 * token itself is shown once, when it is made, and never stored or
 * logged. `parseScannerBearer` accepts exactly `Bearer <token>` (the
 * scheme in any case, one space, 64 lowercase hex characters) and
 * returns null for anything else, which the endpoints answer as no
 * token.
 *
 * `canonicalJson` writes a parsed JSON value with every object's keys
 * sorted and no whitespace, so two bodies that parse to the same value
 * give the same text whatever their key order, spacing or number
 * spelling; `bodyDigest` is the SHA-256 of that text. The contract asks
 * for bodies to be compared as parsed JSON, not as bytes.
 *
 * `SCANNER_NAME_PATTERN` is the unit's short id, the one its bucket keys
 * are named with: lowercase letters, digits and hyphens, 1 to 32
 * characters.
 *
 * @version v0.8.0
 */

export const SCANNER_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
export const SCANNER_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
const BEARER_PATTERN = /^bearer ([0-9a-f]{64})$/i;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The SHA-256 of a string's UTF-8 bytes, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}

/** A new token and its hash. Only the hash may be kept. */
export async function mintScannerToken(): Promise<{ token: string; sha256: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = hex(bytes);
  return { token, sha256: await sha256Hex(token) };
}

export function hashScannerToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** The token of an `Authorization` header, or null when it is not a scanner bearer token. */
export function parseScannerBearer(header: string | null): string | null {
  if (header === null) return null;
  const match = header.match(BEARER_PATTERN);
  if (!match) return null;
  // The scheme may be in any case; the token itself must be lowercase.
  return SCANNER_TOKEN_PATTERN.test(match[1]) ? match[1] : null;
}

/**
 * The deepest nesting a delivered body may have, counted in containers
 * (objects and arrays): the body's own object is level 1, and a scalar
 * adds no level. A capture manifest nests seven levels at its deepest
 * (the envelope, `volumes`, a volume, `records`, a record, `images`,
 * an image), so this leaves room for any fields a later minor version
 * adds.
 */
export const MAX_JSON_DEPTH = 64;

/**
 * The most containers and the most tokens (containers, strings, keys
 * included, numbers and literals) a body may hold. The densest
 * legitimate manifest is one of records without images:
 * `{"captuaRecordId":0,"sequence":0,"status":"captured","rejectionNote":null,"images":[]}`,
 * about 85 bytes with its comma, holding 2 containers and 11 tokens, so
 * a 5 MiB body holds at most some 124,000 containers and 680,000
 * tokens. Each ceiling is about twice that.
 */
export const MAX_JSON_CONTAINERS = 250_000;
export const MAX_JSON_TOKENS = 1_500_000;

export type JsonTextScan = { ok: true } | { ok: false; message: string };

const SCALAR_START = new Set(["-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "t", "f", "n"]);

/**
 * One pass over a body's text before it is parsed, in constant memory:
 * it follows strings and their escapes, the nesting depth, and counts
 * containers and tokens, and refuses a body past `MAX_JSON_DEPTH`,
 * `MAX_JSON_CONTAINERS` or `MAX_JSON_TOKENS`. It does not check that
 * the text is JSON; `JSON.parse` does that afterwards, on a body this
 * pass has bounded.
 */
export function scanJsonText(text: string): JsonTextScan {
  let depth = 0;
  let containers = 0;
  let tokens = 0;
  let inString = false;
  let escaped = false;
  let expectValue = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    switch (c) {
      case '"':
        inString = true;
        tokens++;
        expectValue = false;
        break;
      case "{":
      case "[":
        depth++;
        containers++;
        tokens++;
        expectValue = true;
        if (depth > MAX_JSON_DEPTH) return { ok: false, message: `The body nests deeper than ${MAX_JSON_DEPTH} levels` };
        break;
      case "}":
      case "]":
        depth--;
        expectValue = false;
        break;
      case ",":
      case ":":
        expectValue = true;
        break;
      case " ":
      case "\t":
      case "\n":
      case "\r":
        break;
      default:
        if (expectValue && SCALAR_START.has(c)) tokens++;
        expectValue = false;
    }
    if (containers > MAX_JSON_CONTAINERS) {
      return { ok: false, message: `The body holds more than ${MAX_JSON_CONTAINERS} objects and arrays` };
    }
    if (tokens > MAX_JSON_TOKENS) return { ok: false, message: `The body holds more than ${MAX_JSON_TOKENS} values` };
  }
  return { ok: true };
}

/**
 * A parsed JSON value written with sorted keys and no whitespace. It
 * recurses, so it is only given a body `scanJsonText` has passed; a
 * container past `MAX_JSON_DEPTH`, counted as that scan counts, throws a
 * RangeError of its own rather than overrunning the stack.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const level = depth + 1;
  if (level > MAX_JSON_DEPTH) throw new RangeError(`JSON nests deeper than ${MAX_JSON_DEPTH} levels`);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, level)).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k], level)}`);
  return `{${entries.join(",")}}`;
}

/** The SHA-256 of a parsed body's canonical form. */
export function bodyDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

// @version v0.8.0
