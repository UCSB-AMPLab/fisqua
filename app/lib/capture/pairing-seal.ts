/**
 * Capture Pairing — Sealed Key Envelope
 *
 * This module seals the B2 key pairs Fisqua stores for a workspace's
 * scanner and opens them again. The operator seals them on their own
 * machine with the environment's public key; the Worker opens them with
 * the private key it holds as a secret. It uses only the global Web
 * Crypto and imports nothing Worker-only, so the Worker and the
 * operator's commands both import this file.
 *
 * The scheme: `sealKeys` makes an ephemeral P-256 key pair, derives
 * shared bits by ECDH with the recipient's public key, and runs
 * HKDF-SHA-256 over them (salt of 32 zero bytes, info
 * `fisqua-capture-keys-v1`) to an AES-256-GCM key. With it, the UTF-8
 * JSON of the key pairs is encrypted under a fresh 12-byte IV, with
 * `${tenantId}|${environment}` as additional data, so a ciphertext
 * copied to another workspace or environment cannot be opened. The
 * ephemeral key pair is non-extractable; only its public key is
 * exported.
 *
 * `sealKeys` throws a fixed message unless its input is the
 * `StoredKeyPairs` shape (four non-empty strings), and seals only those
 * four fields.
 *
 * The sealed text is the JSON `{ v: 1, epk, iv, ct }`: `epk` is the
 * ephemeral public JWK, `iv` and `ct` are base64url without padding.
 * `openKeys` throws on a wrong version, malformed JSON, a missing field,
 * a failed decryption, or a decrypted value that is not JSON or not four
 * non-empty strings in the `StoredKeyPairs` shape; the last two throw
 * one fixed message, so no part of the decrypted text reaches an error.
 *
 * `generatePairingKeyPair` makes an environment's pair as extractable
 * JWKs; the private JWK is imported for `deriveBits` only.
 *
 * @version v0.9.0
 */

export type SealedKeys = string;

export interface StoredKeyPairs {
  writeKey: { keyId: string; applicationKey: string };
  readKey: { keyId: string; applicationKey: string };
}

export interface SealBinding {
  tenantId: string;
  environment: "production" | "staging";
}

const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;
const HKDF_INFO = new TextEncoder().encode("fisqua-capture-keys-v1");
const HKDF_SALT = new Uint8Array(32);
const IV_BYTES = 12;
/** The one message for decrypted text that is not JSON or not the `StoredKeyPairs` shape. */
const WRONG_SHAPE = "Opened keys have the wrong shape";

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Not base64url");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bindingBytes(aad: SealBinding): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${aad.tenantId}|${aad.environment}`);
}

async function aesKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function publicPart(jwk: JsonWebKey): JsonWebKey {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isKeyPair(value: unknown): value is { keyId: string; applicationKey: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isNonEmptyString(v.keyId) && isNonEmptyString(v.applicationKey);
}

/** The four fields of `StoredKeyPairs`, or null when `value` is not that shape. */
function storedKeyPairs(value: unknown): StoredKeyPairs | null {
  if (typeof value !== "object" || value === null) return null;
  const { writeKey, readKey } = value as Record<string, unknown>;
  if (!isKeyPair(writeKey) || !isKeyPair(readKey)) return null;
  return {
    writeKey: { keyId: writeKey.keyId, applicationKey: writeKey.applicationKey },
    readKey: { keyId: readKey.keyId, applicationKey: readKey.applicationKey },
  };
}

export async function generatePairingKeyPair(): Promise<{ publicJwk: JsonWebKey; privateJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey(CURVE, true, ["deriveBits"])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { publicJwk, privateJwk };
}

export async function sealKeys(
  publicJwk: JsonWebKey,
  keys: StoredKeyPairs,
  aad: SealBinding,
): Promise<SealedKeys> {
  const toSeal = storedKeyPairs(keys);
  if (!toSeal) throw new Error("Keys to seal have the wrong shape");
  const recipient = await crypto.subtle.importKey("jwk", publicPart(publicJwk), CURVE, false, []);
  const ephemeral = (await crypto.subtle.generateKey(CURVE, false, ["deriveBits"])) as CryptoKeyPair;
  const key = await aesKey(ephemeral.privateKey, recipient);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify(toSeal));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: bindingBytes(aad) }, key, plain),
  );
  const epk = publicPart((await crypto.subtle.exportKey("jwk", ephemeral.publicKey)) as JsonWebKey);
  return JSON.stringify({ v: 1, epk, iv: toBase64Url(iv), ct: toBase64Url(ct) });
}

export async function openKeys(
  privateJwk: JsonWebKey,
  sealed: SealedKeys,
  aad: SealBinding,
): Promise<StoredKeyPairs> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(sealed);
  } catch {
    throw new Error("Sealed keys are not JSON");
  }
  if (typeof envelope !== "object" || envelope === null) throw new Error("Sealed keys are not an object");
  const { v, epk, iv, ct } = envelope as Record<string, unknown>;
  if (v !== 1) throw new Error("Sealed keys have an unknown version");
  if (typeof epk !== "object" || epk === null || !isNonEmptyString(iv) || !isNonEmptyString(ct)) {
    throw new Error("Sealed keys are missing a field");
  }
  const ivBytes = fromBase64Url(iv);
  if (ivBytes.length !== IV_BYTES) throw new Error("Sealed keys have a malformed IV");

  const own = await crypto.subtle.importKey("jwk", privateJwk, CURVE, false, ["deriveBits"]);
  const sender = await crypto.subtle.importKey("jwk", publicPart(epk as JsonWebKey), CURVE, false, []);
  const key = await aesKey(own, sender);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes, additionalData: bindingBytes(aad) },
    key,
    fromBase64Url(ct),
  );

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error(WRONG_SHAPE);
  }
  const opened = storedKeyPairs(value);
  if (!opened) throw new Error(WRONG_SHAPE);
  return opened;
}

// @version v0.9.0
