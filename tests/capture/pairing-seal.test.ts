/**
 * Tests — the sealed key envelope
 *
 * This suite pins the envelope the B2 key pairs are stored in: a seal
 * made with a public key can be opened only with its private key and
 * the same tenant and environment. Two seals of the same input differ,
 * since each uses a fresh ephemeral key and IV. A ciphertext or IV
 * altered by one byte, an `epk` on another curve, and a decrypted value
 * that is not JSON or not the `StoredKeyPairs` shape are refused, the
 * last two with one fixed message. `sealKeys` refuses input that is not
 * the `StoredKeyPairs` shape, seals only its four fields, and makes its
 * ephemeral key pair non-extractable. The key material here is made up.
 *
 * @version v0.9.0
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generatePairingKeyPair,
  openKeys,
  sealKeys,
  type StoredKeyPairs,
} from "../../app/lib/capture/pairing-seal";

const keys: StoredKeyPairs = {
  writeKey: { keyId: "0001-write-test", applicationKey: "K001writeMadeUpSecret" },
  readKey: { keyId: "0001-read-test", applicationKey: "K001readMadeUpSecret" },
};
const aad = { tenantId: "tenant-one", environment: "production" as const };

const SHAPE_MESSAGE = /^Opened keys have the wrong shape$/;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The envelope's AES key, derived by hand with the scheme the module documents. */
async function aesKeyByHand(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode("fisqua-capture-keys-v1"),
    },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const P256 = { name: "ECDH", namedCurve: "P-256" } as const;
const binding = (a: typeof aad) => new TextEncoder().encode(`${a.tenantId}|${a.environment}`);

/** A valid envelope around any plaintext, built without `sealKeys`. */
async function sealByHand(publicJwk: JsonWebKey, plaintext: string): Promise<string> {
  const recipient = await crypto.subtle.importKey(
    "jwk",
    { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    P256,
    false,
    [],
  );
  const eph = (await crypto.subtle.generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair;
  const key = await aesKeyByHand(eph.privateKey, recipient);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: binding(aad) },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const epk = (await crypto.subtle.exportKey("jwk", eph.publicKey)) as JsonWebKey;
  return JSON.stringify({ v: 1, epk: { kty: epk.kty, crv: epk.crv, x: epk.x, y: epk.y }, iv: b64url(iv), ct: b64url(ct) });
}

/** The plaintext of an envelope, decrypted without `openKeys`. */
async function openByHand(privateJwk: JsonWebKey, sealed: string): Promise<string> {
  const env = JSON.parse(sealed);
  const own = await crypto.subtle.importKey("jwk", privateJwk, P256, false, ["deriveBits"]);
  const sender = await crypto.subtle.importKey("jwk", env.epk, P256, false, []);
  const key = await aesKeyByHand(own, sender);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64url(env.iv), additionalData: binding(aad) },
    key,
    unb64url(env.ct),
  );
  return new TextDecoder().decode(plain);
}

/** The base64url text with its byte at `index` changed. */
function flipByte(text: string, index: number): string {
  const bytes = unb64url(text);
  bytes[index] ^= 0x01;
  return b64url(bytes);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sealKeys and openKeys", () => {
  it("opens what it sealed", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const sealed = await sealKeys(publicJwk, keys, aad);
    expect(await openKeys(privateJwk, sealed, aad)).toEqual(keys);
  });

  it("writes version 1 with base64url fields", async () => {
    const { publicJwk } = await generatePairingKeyPair();
    const env = JSON.parse(await sealKeys(publicJwk, keys, aad));
    expect(env.v).toBe(1);
    expect(env.epk.kty).toBe("EC");
    expect(env.epk.d).toBeUndefined();
    expect(env.iv).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(env.ct).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses another tenant", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const sealed = await sealKeys(publicJwk, keys, aad);
    await expect(
      openKeys(privateJwk, sealed, { tenantId: "other", environment: "production" }),
    ).rejects.toThrow();
  });

  it("refuses another environment", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const sealed = await sealKeys(publicJwk, keys, aad);
    await expect(
      openKeys(privateJwk, sealed, { tenantId: "tenant-one", environment: "staging" }),
    ).rejects.toThrow();
  });

  it("refuses another key pair's private key", async () => {
    const a = await generatePairingKeyPair();
    const b = await generatePairingKeyPair();
    const sealed = await sealKeys(a.publicJwk, keys, aad);
    await expect(openKeys(b.privateJwk, sealed, aad)).rejects.toThrow();
  });

  it("gives two different seals of the same input", async () => {
    const { publicJwk } = await generatePairingKeyPair();
    const one = await sealKeys(publicJwk, keys, aad);
    const two = await sealKeys(publicJwk, keys, aad);
    expect(one).not.toBe(two);
    expect(JSON.parse(one).iv).not.toBe(JSON.parse(two).iv);
    expect(JSON.parse(one).epk.x).not.toBe(JSON.parse(two).epk.x);
  });

  it("refuses a malformed envelope or a wrong version", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const sealed = await sealKeys(publicJwk, keys, aad);
    await expect(openKeys(privateJwk, "not json", aad)).rejects.toThrow();
    await expect(
      openKeys(privateJwk, JSON.stringify({ ...JSON.parse(sealed), v: 2 }), aad),
    ).rejects.toThrow();
    const { ct: _ct, ...noCt } = JSON.parse(sealed);
    await expect(openKeys(privateJwk, JSON.stringify(noCt), aad)).rejects.toThrow();
  });

  it("refuses a ciphertext altered by one byte", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const env = JSON.parse(await sealKeys(publicJwk, keys, aad));
    const altered = JSON.stringify({ ...env, ct: flipByte(env.ct, 3) });
    await expect(openKeys(privateJwk, altered, aad)).rejects.toThrow();
  });

  it("refuses an IV altered by one byte", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const env = JSON.parse(await sealKeys(publicJwk, keys, aad));
    const altered = JSON.stringify({ ...env, iv: flipByte(env.iv, 0) });
    await expect(openKeys(privateJwk, altered, aad)).rejects.toThrow();
  });

  it("refuses an epk on another curve", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const env = JSON.parse(await sealKeys(publicJwk, keys, aad));
    const other = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-384" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const p384 = (await crypto.subtle.exportKey("jwk", other.publicKey)) as JsonWebKey;
    const altered = JSON.stringify({ ...env, epk: { kty: p384.kty, crv: p384.crv, x: p384.x, y: p384.y } });
    await expect(openKeys(privateJwk, altered, aad)).rejects.toThrow();
  });

  it("refuses a valid seal whose plaintext has the wrong shape, with the fixed message", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const wrongShape = await sealByHand(
      publicJwk,
      JSON.stringify({ writeKey: { keyId: "0001-write-test" }, readKey: keys.readKey }),
    );
    await expect(openKeys(privateJwk, wrongShape, aad)).rejects.toThrow(SHAPE_MESSAGE);
  });

  it("refuses a valid seal whose plaintext is not JSON, with the same fixed message", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const notJson = await sealByHand(publicJwk, "{K001madeUpFragment");
    await expect(openKeys(privateJwk, notJson, aad)).rejects.toThrow(SHAPE_MESSAGE);
  });
});

describe("sealKeys input", () => {
  it("refuses an empty applicationKey", async () => {
    const { publicJwk } = await generatePairingKeyPair();
    const bad = { ...keys, readKey: { keyId: "0001-read-test", applicationKey: "" } };
    await expect(sealKeys(publicJwk, bad, aad)).rejects.toThrow(/^Keys to seal have the wrong shape$/);
  });

  it("refuses a value that is not the StoredKeyPairs shape", async () => {
    const { publicJwk } = await generatePairingKeyPair();
    for (const bad of [null, {}, { writeKey: keys.writeKey }, { ...keys, writeKey: { keyId: 1, applicationKey: "x" } }]) {
      await expect(sealKeys(publicJwk, bad as unknown as StoredKeyPairs, aad)).rejects.toThrow(
        /^Keys to seal have the wrong shape$/,
      );
    }
  });

  it("seals only the four fields of StoredKeyPairs", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const extra = {
      ...keys,
      note: "not sealed",
      writeKey: { ...keys.writeKey, bucket: "not sealed" },
    } as unknown as StoredKeyPairs;
    const plain = JSON.parse(await openByHand(privateJwk, await sealKeys(publicJwk, extra, aad)));
    expect(plain).toEqual(keys);
  });

  it("makes its ephemeral key pair non-extractable", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const spy = vi.spyOn(crypto.subtle, "generateKey");
    const sealed = await sealKeys(publicJwk, keys, aad);
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) expect(call[1]).toBe(false);
    expect(await openKeys(privateJwk, sealed, aad)).toEqual(keys);
  });
});

// @version v0.9.0
