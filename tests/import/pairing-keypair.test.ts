/**
 * Tests — the pairing key pair command
 *
 * This suite pins the operator command that makes an environment's
 * pairing key pair, run against an in-memory Keychain and a fixed key
 * generator. Nothing here reaches the real Keychain.
 *
 *   - arguments: `--target` is required; `--apply` against production
 *     also needs `--confirm-production`;
 *   - a dry run generates no key and writes nothing to the Keychain;
 *   - an applied run writes the private JWK to the Keychain, service
 *     `fisqua-pairing`, account `{target}-private-jwk`, and prints the
 *     public JWK on one line, which entry of `PAIRING_PUBLIC_KEYS` to
 *     set, and the `wrangler secret put CAPTURE_KEYS_PRIVATE_JWK` step,
 *     never the private key;
 *   - the command refuses a target whose Keychain account exists, and
 *     generates nothing;
 *   - the command reads the private JWK back from the Keychain after
 *     writing it, and stops without printing a public key when the item
 *     is absent or holds another value;
 *   - the operator runs the printed Worker step under `set -o pipefail`,
 *     and the instruction to confirm pairing on that environment follows
 *     it;
 *   - keys sealed with the printed public key can be opened with the
 *     stored private key;
 *   - the appliance key writer (`macKeychain`) gives `security -i` the
 *     value on stdin only, never in an argument;
 *   - the Keychain line given to `security -i` holds the value only as
 *     hexadecimal and refuses a service or account it cannot quote.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { ProvisionStop } from "../../scripts/lib/tenant-storage";
import { addGenericPasswordLine, writeGenericPassword, type KeychainStore } from "../../scripts/lib/keychain";
import {
  parseArgs,
  PAIRING_KEYCHAIN_SERVICE,
  privateKeyAccount,
  runPairingKeypair,
} from "../../scripts/commands/pairing-keypair";
import { keychainWriterOver } from "../../scripts/lib/appliance-key";
import { generatePairingKeyPair, openKeys, sealKeys } from "../../app/lib/capture/pairing-seal";

function capture() {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l), text: () => lines.join("\n") };
}

async function stopped(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProvisionStop) return err.message;
    throw err;
  }
  throw new Error("expected the command to stop");
}

function memoryKeychain(existing: Array<[string, string]> = []) {
  const items = new Map<string, string>(existing.map(([s, a]) => [`${s}\u0000${a}`, "made-up"]));
  const added: Array<{ service: string; account: string; value: string }> = [];
  const store: KeychainStore = {
    has: (service, account) => items.has(`${service}\u0000${account}`),
    read: (service, account) => items.get(`${service}\u0000${account}`) ?? null,
    add: (service, account, value) => {
      if (items.has(`${service}\u0000${account}`)) throw new Error("exists");
      items.set(`${service}\u0000${account}`, value);
      added.push({ service, account, value });
    },
  };
  return { store, added };
}

function counted() {
  let calls = 0;
  let last: { publicJwk: JsonWebKey; privateJwk: JsonWebKey } | null = null;
  return {
    get calls() {
      return calls;
    },
    get last() {
      return last;
    },
    generate: async () => {
      calls++;
      last = await generatePairingKeyPair();
      return last;
    },
  };
}

describe("parseArgs", () => {
  it("needs --target, staging or production", () => {
    expect(() => parseArgs([])).toThrow(/--target is required/);
    expect(() => parseArgs(["--target", "local"])).toThrow(/--target is required/);
    expect(parseArgs(["--target", "staging"])).toEqual({ target: "staging", apply: false, confirmProduction: false });
  });

  it("refuses --apply against production without --confirm-production", () => {
    expect(() => parseArgs(["--target", "production", "--apply"])).toThrow(/--confirm-production/);
    expect(parseArgs(["--target", "production", "--apply", "--confirm-production"])).toEqual({
      target: "production",
      apply: true,
      confirmProduction: true,
    });
  });

  it("refuses an unknown argument", () => {
    expect(() => parseArgs(["--target", "staging", "--force"])).toThrow(/Unknown argument/);
  });
});

describe("runPairingKeypair", () => {
  it("names the Keychain entry fisqua-pairing / {target}-private-jwk", () => {
    expect(PAIRING_KEYCHAIN_SERVICE).toBe("fisqua-pairing");
    expect(privateKeyAccount("staging")).toBe("staging-private-jwk");
    expect(privateKeyAccount("production")).toBe("production-private-jwk");
  });

  it("dry run: generates no key and writes nothing", async () => {
    const { store, added } = memoryKeychain();
    const gen = counted();
    const out = capture();
    await runPairingKeypair({ target: "staging", apply: false, confirmProduction: false }, { keychain: store, generate: gen.generate }, out.log);
    expect(gen.calls).toBe(0);
    expect(added).toEqual([]);
    expect(out.text()).toContain("fisqua-pairing");
    expect(out.text()).toContain("staging-private-jwk");
    expect(out.text()).toContain("Dry run: nothing was written");
  });

  it("apply: stores the private JWK in the Keychain and prints only the public JWK", async () => {
    const { store, added } = memoryKeychain();
    const gen = counted();
    const out = capture();
    await runPairingKeypair({ target: "staging", apply: true, confirmProduction: false }, { keychain: store, generate: gen.generate }, out.log);
    expect(gen.calls).toBe(1);
    const pair = gen.last!;
    expect(added).toHaveLength(1);
    expect(added[0].service).toBe("fisqua-pairing");
    expect(added[0].account).toBe("staging-private-jwk");
    expect(JSON.parse(added[0].value)).toMatchObject({ kty: "EC", crv: "P-256", d: pair.privateJwk.d });

    const text = out.text();
    expect(text).not.toContain(pair.privateJwk.d!);
    expect(text).not.toContain(added[0].value);
    const jwkLine = out.lines.find((l) => l.trim().startsWith("{"));
    expect(jwkLine).toBeDefined();
    const printed = JSON.parse(jwkLine!.trim()) as JsonWebKey;
    expect(printed).toEqual({ kty: "EC", crv: "P-256", x: pair.publicJwk.x, y: pair.publicJwk.y });
    expect(printed.d).toBeUndefined();
    expect(text).toContain("PAIRING_PUBLIC_KEYS.staging");
    expect(text).toContain("wrangler secret put CAPTURE_KEYS_PRIVATE_JWK --env staging");
    expect(text).toMatch(/set -o pipefail; security find-generic-password -s fisqua-pairing -a staging-private-jwk -w \| /);
    expect(text).toMatch(/confirm .*pairing works on staging.* before storing any keys/i);
    expect(text).not.toContain("Dry run");
  });

  it("apply on production: names the production entry and no --env", async () => {
    const { store, added } = memoryKeychain();
    const gen = counted();
    const out = capture();
    await runPairingKeypair({ target: "production", apply: true, confirmProduction: true }, { keychain: store, generate: gen.generate }, out.log);
    expect(added[0].account).toBe("production-private-jwk");
    expect(out.text()).toContain("PAIRING_PUBLIC_KEYS.production");
    expect(out.text()).toMatch(/wrangler secret put CAPTURE_KEYS_PRIVATE_JWK$/m);
    expect(out.text()).not.toContain("--env staging");
  });

  it("refuses a target whose Keychain account exists, generating nothing", async () => {
    for (const apply of [false, true]) {
      const { store, added } = memoryKeychain([["fisqua-pairing", "staging-private-jwk"]]);
      const gen = counted();
      const message = await stopped(
        runPairingKeypair({ target: "staging", apply, confirmProduction: false }, { keychain: store, generate: gen.generate }, capture().log),
      );
      expect(message).toContain("staging-private-jwk");
      expect(gen.calls).toBe(0);
      expect(added).toEqual([]);
    }
  });

  it("stops without printing a public key when the Keychain write did not store the value", async () => {
    const lost: KeychainStore = { has: () => false, read: () => null, add: () => {} };
    const stored = new Map<string, string>();
    const other: KeychainStore = {
      has: () => false,
      read: (s, a) => stored.get(`${s}/${a}`) ?? null,
      add: (s, a) => {
        stored.set(`${s}/${a}`, '{"kty":"EC","d":"an-older-made-up-key"}');
      },
    };
    for (const keychain of [lost, other]) {
      const gen = counted();
      const out = capture();
      const message = await stopped(
        runPairingKeypair({ target: "staging", apply: true, confirmProduction: false }, { keychain, generate: gen.generate }, out.log),
      );
      expect(message).toContain("fisqua-pairing");
      expect(message).toContain("staging-private-jwk");
      expect(message).not.toContain(gen.last!.privateJwk.d!);
      expect(out.lines.some((l) => l.trim().startsWith("{"))).toBe(false);
      expect(out.text()).not.toContain(gen.last!.publicJwk.x!);
      expect(out.text()).not.toContain("PAIRING_PUBLIC_KEYS");
    }
  });

  it("the printed public key seals keys that the stored private key opens", async () => {
    const { store, added } = memoryKeychain();
    const out = capture();
    await runPairingKeypair({ target: "staging", apply: true, confirmProduction: false }, { keychain: store, generate: generatePairingKeyPair }, out.log);
    const publicJwk = JSON.parse(out.lines.find((l) => l.trim().startsWith("{"))!.trim()) as JsonWebKey;
    const keys = {
      writeKey: { keyId: "made-up-write-id", applicationKey: "made-up-write-secret" },
      readKey: { keyId: "made-up-read-id", applicationKey: "made-up-read-secret" },
    };
    const binding = { tenantId: "tenant-1", environment: "staging" as const };
    const sealed = await sealKeys(publicJwk, keys, binding);
    expect(await openKeys(JSON.parse(added[0].value) as JsonWebKey, sealed, binding)).toEqual(keys);
  });
});

describe("addGenericPasswordLine", () => {
  it("passes the value as hexadecimal only", () => {
    const value = '{"kty":"EC","d":"made-up-private"}';
    const line = addGenericPasswordLine("fisqua-pairing", "staging-private-jwk", value);
    expect(line).toBe(
      `add-generic-password -s fisqua-pairing -a staging-private-jwk -X ${Buffer.from(value, "utf8").toString("hex")}\n`,
    );
    expect(line).not.toContain("made-up-private");
  });

  it("refuses a service or account with characters it cannot pass unquoted", () => {
    expect(() => addGenericPasswordLine("fisqua pairing", "a", "v")).toThrow();
    expect(() => addGenericPasswordLine("s", "a\"b", "v")).toThrow();
    expect(() => addGenericPasswordLine("s", "", "v")).toThrow();
  });
});

describe("the appliance key writer (macKeychain)", () => {
  const secret = 'sec"ret\\with quote\nand newline';

  function fakeRun() {
    const calls: Array<{ args: string[]; input: string }> = [];
    return { calls, run: (args: string[], input: string) => void calls.push({ args, input }) };
  }

  it("keeps the secret out of every argument and puts it on stdin as hexadecimal, with -U", () => {
    const { calls, run } = fakeRun();
    keychainWriterOver(run)("fisqua-appliance", "fisqua-acme-appliance-a1-secret", secret);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["-i"]);
    for (const arg of calls[0].args) expect(arg).not.toContain(secret);
    expect(calls[0].input).toBe(
      `add-generic-password -U -s fisqua-appliance -a fisqua-acme-appliance-a1-secret -X ${Buffer.from(secret, "utf8").toString("hex")}\n`,
    );
    expect(calls[0].input).not.toContain("with quote");
    expect(calls[0].input.indexOf("\n")).toBe(calls[0].input.length - 1);
  });

  it("carries quotes, backslashes and newlines in the value without quoting, one line on stdin", () => {
    const { calls, run } = fakeRun();
    keychainWriterOver(run)("s", "a", secret);
    expect(calls[0].input.split("\n")).toHaveLength(2);
    expect(calls[0].input).not.toMatch(/["\\]/);
  });

  it("names the service, account and exit status on failure, never the value", () => {
    const run = () => {
      throw Object.assign(new Error("Command failed: security -i"), { status: 36 });
    };
    let message = "";
    try {
      writeGenericPassword(run, "fisqua-appliance", "acct-secret", secret, true);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("acct-secret");
    expect(message).toContain("(exit 36)");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(Buffer.from(secret, "utf8").toString("hex"));
  });

  it("add (no -U) leaves the flag out", () => {
    expect(addGenericPasswordLine("s", "a", "v")).not.toContain("-U");
  });
});

// @version v0.9.0
