#!/usr/bin/env npx tsx
/**
 * Pairing Key Pair — Make an Environment's Key Pair for Stored Scanner Keys
 *
 * Fisqua keeps a workspace's scanner keys (the B2 key pairs a capture
 * appliance uploads and reads with) sealed in D1, so that a unit can be
 * paired with its workspace by a code and collect them. The operator
 * seals them on their own machine with the environment's public key
 * (`store-appliance-keys.ts`), and the Worker opens them with the
 * private key, which it holds as the secret `CAPTURE_KEYS_PRIVATE_JWK`.
 * This command makes that key pair for one environment: ECDH on P-256,
 * as JWKs, through `generatePairingKeyPair`
 * (`app/lib/capture/pairing-seal.ts`).
 *
 * With `--apply` it writes the private JWK, as JSON text, to the macOS
 * login Keychain, service `fisqua-pairing`, account
 * `{target}-private-jwk`, through `macKeychainStore`
 * (`scripts/lib/keychain.ts`), which passes the value on stdin and never
 * as an argument. It reads the item back and stops, printing no public
 * key, unless the item holds exactly the private key it made: a public
 * key printed without its private half stored would seal rows that
 * nothing can open. It then prints the public JWK on one line, which
 * entry of `PAIRING_PUBLIC_KEYS` (`app/lib/capture/pairing-public-keys.ts`)
 * to set to it, and the command that hands the private key from the
 * Keychain to `wrangler secret put CAPTURE_KEYS_PRIVATE_JWK` through a
 * pipe, under `set -o pipefail` so that a failed lookup does not set an
 * empty secret, and the instruction to confirm that pairing works on
 * that environment before any keys are stored. It never prints the
 * private key, and writes no file.
 *
 * It refuses a target whose Keychain account already exists, so a pair
 * already in use is never replaced by accident. Replacing a pair means
 * deleting that Keychain item by hand, running this again, and storing
 * every workspace's keys again under the new public key.
 *
 * A dry run is the default: it checks the Keychain account and prints
 * what it would do, and generates no key. `--apply` against production
 * also needs `--confirm-production`.
 *
 * Usage:
 *   npx tsx scripts/commands/pairing-keypair.ts --target staging
 *   npx tsx scripts/commands/pairing-keypair.ts --target staging --apply
 *   npx tsx scripts/commands/pairing-keypair.ts --target production --apply --confirm-production
 *
 * @version v0.9.0
 */

import { pathToFileURL } from "node:url";
import { ProvisionStop } from "../lib/tenant-storage";
import { macKeychainStore, type KeychainStore } from "../lib/keychain";
import { generatePairingKeyPair } from "../../app/lib/capture/pairing-seal";

/** The Keychain service the pairing private keys are stored under. */
export const PAIRING_KEYCHAIN_SERVICE = "fisqua-pairing";

export type PairingTarget = "staging" | "production";

/** The Keychain account that holds a target's private JWK. */
export function privateKeyAccount(target: PairingTarget): string {
  return `${target}-private-jwk`;
}

export interface KeypairCliOptions {
  target: PairingTarget;
  apply: boolean;
  confirmProduction: boolean;
}

export interface KeypairProviders {
  keychain: Pick<KeychainStore, "has" | "read" | "add">;
  generate: () => Promise<{ publicJwk: JsonWebKey; privateJwk: JsonWebKey }>;
}

export function parseArgs(argv: string[]): KeypairCliOptions {
  let target: string | null = null;
  let apply = false;
  let confirmProduction = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--target") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      target = v;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (target !== "staging" && target !== "production") {
    throw new Error("--target is required (staging or production)");
  }
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return { target, apply, confirmProduction };
}

/** The public part of a JWK: the members a P-256 public key needs, in a fixed order. */
function publicOnly(jwk: JsonWebKey): JsonWebKey {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/** Makes the target's key pair, or with no `apply` prints what it would do. */
export async function runPairingKeypair(
  options: KeypairCliOptions,
  providers: KeypairProviders,
  log: (line: string) => void,
): Promise<void> {
  const { target, apply } = options;
  const account = privateKeyAccount(target);
  const wranglerEnv = target === "staging" ? " --env staging" : "";

  log(`Pairing key pair for ${target}${apply ? "" : ", dry run"}`);
  log(`  Keychain service:   ${PAIRING_KEYCHAIN_SERVICE}`);
  log(`  Keychain account:   ${account}`);
  if (providers.keychain.has(PAIRING_KEYCHAIN_SERVICE, account)) {
    throw new ProvisionStop(
      `The Keychain already holds ${PAIRING_KEYCHAIN_SERVICE} / ${account}. The command replaces no key pair: ` +
        "to make a new one, delete that item by hand and store every workspace's keys again afterwards",
    );
  }
  if (!apply) {
    log(`  [create] would make a P-256 key pair, store the private JWK in the Keychain and print the public JWK`);
    log("\nDry run: nothing was written. Run with --apply to write.");
    return;
  }

  const { publicJwk, privateJwk } = await providers.generate();
  const value = JSON.stringify(privateJwk);
  providers.keychain.add(PAIRING_KEYCHAIN_SERVICE, account, value);
  if (providers.keychain.read(PAIRING_KEYCHAIN_SERVICE, account) !== value) {
    throw new ProvisionStop(
      `The Keychain item ${PAIRING_KEYCHAIN_SERVICE} / ${account} does not hold the private key just made, ` +
        "so no public key is printed. Check that item by hand, delete it if it is stale, and run the command again",
    );
  }
  log(`  [create] stored the private JWK in the Keychain, service ${PAIRING_KEYCHAIN_SERVICE}, account ${account}`);
  log("");
  log(`Public JWK; set PAIRING_PUBLIC_KEYS.${target} in app/lib/capture/pairing-public-keys.ts to it:`);
  log(JSON.stringify(publicOnly(publicJwk)));
  log("");
  log(`Put the private key in the ${target} Worker, from the Keychain through a pipe:`);
  log(
    `  set -o pipefail; security find-generic-password -s ${PAIRING_KEYCHAIN_SERVICE} -a ${account} -w | ` +
      `npx wrangler secret put CAPTURE_KEYS_PRIVATE_JWK${wranglerEnv}`,
  );
  log(`Then confirm that pairing works on ${target} before storing any keys with store-appliance-keys.ts.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runPairingKeypair(
    options,
    { keychain: macKeychainStore, generate: generatePairingKeyPair },
    (line) => console.log(line),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.9.0
