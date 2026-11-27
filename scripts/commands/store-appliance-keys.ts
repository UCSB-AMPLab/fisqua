#!/usr/bin/env npx tsx
/**
 * Store Appliance Keys — Seal a Workspace's Scanner Keys and Store Them in D1
 *
 * This script seals a workspace's scanner keys and stores them in D1. A
 * capture appliance (Captua) is paired with its workspace by a code, and
 * on collection receives the B2 key pairs it uploads and reads with.
 * Fisqua keeps those key pairs per workspace, sealed, in
 * `capture_scanner_keys`; this script puts them there. It runs on the
 * operator's machine, beside `provision-appliance-key.ts`, which mints the
 * keys and which it leaves unchanged.
 *
 * It reads the two key pairs the minting command put in the macOS login
 * Keychain: service `fisqua-appliance`, accounts `{key name}-id` and
 * `{key name}-secret`, for the upload key
 * `fisqua-{slug}[-staging]-appliance-{id}` and the read key, the same
 * name with `-read` (`applianceKeyNames`,
 * `app/lib/capture/appliance-key-names.ts`). It stops when any of the
 * four entries is missing. It reads the tenant and its federation's
 * masters bucket from D1 through wrangler, read only, as the minting
 * command does (`resolveTenantStorage`), and stops for a tenant whose
 * federation has no complete storage record.
 *
 * It seals the two pairs with the target's public key from
 * `PAIRING_PUBLIC_KEYS` (`app/lib/capture/pairing-public-keys.ts`) and
 * stops when that entry is null. The seal (`sealKeys`,
 * `app/lib/capture/pairing-seal.ts`) binds the sealed text to the
 * tenant's id and the target, so the Worker cannot open a row copied to
 * another workspace or environment. It then writes one row: the sealed text,
 * the bucket, the appliance id, the age recipient (a public key, stored
 * as given) and the time of storing in milliseconds. A first store
 * inserts revision 1; a later one replaces the row, clears an erasure
 * (`erased_at`, `erased_by`) and raises the revision by one
 * (`storeKeysStatement`). A raised revision voids the workspace's
 * approved codes that have not been collected: the unit asks for a new
 * code and the approver approves again.
 *
 * Secrets. The key ids and secrets are read from the Keychain on stdout
 * of `security` (`macKeychainStore`, `scripts/lib/keychain.ts`), are
 * never printed, and are never written to disk in plain. wrangler takes
 * the statement as a file: the command writes it, holding only the
 * sealed text, to a fresh directory made with `mkdtemp`, mode 0600, and
 * removes the directory when wrangler returns or fails. The log carries
 * the key names, the Keychain accounts, the bucket, the appliance id,
 * the age recipient and the new revision. When the write succeeds and
 * the revision cannot be read back, the command stops saying that the
 * row was stored.
 *
 * `--tenant` must be a tenant slug and `--appliance` an appliance id, as
 * the minting command checks them, and `--age-recipient` must match
 * `^age1[0-9a-z]{58}$`; all are checked before anything is read.
 *
 * A dry run is the default: it reads D1, checks that the four Keychain
 * entries exist without reading their values, prints what it would
 * store, and writes nothing. `--apply` writes. `--apply` against
 * production also needs `--confirm-production`. Nothing is deployed.
 *
 * Usage:
 *   npx tsx scripts/commands/store-appliance-keys.ts --tenant sbmal --appliance rig-1 --target staging --age-recipient age1…
 *   npx tsx scripts/commands/store-appliance-keys.ts --tenant sbmal --appliance rig-1 --target staging --age-recipient age1… --apply
 *
 * @version v0.9.0
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  d1Args,
  execCommand,
  ProvisionStop,
  resolveTenantStorage,
  SLUG_PATTERN,
  wranglerD1,
  type CommandRunner,
  type D1Api,
} from "../lib/tenant-storage";
import { runD1, runD1Json } from "../lib/d1-cli";
import { escapeSql } from "../lib/sql";
import { APPLIANCE_ID_PATTERN, KEYCHAIN_SERVICE, keychainAccounts } from "../lib/appliance-key";
import { macKeychainStore, type KeychainStore } from "../lib/keychain";
import { applianceKeyNames } from "../../app/lib/capture/appliance-key-names";
import { sealKeys } from "../../app/lib/capture/pairing-seal";
import { PAIRING_PUBLIC_KEYS } from "../../app/lib/capture/pairing-public-keys";

/** An age X25519 recipient, as this command accepts it. */
export const AGE_RECIPIENT_PATTERN = /^age1[0-9a-z]{58}$/;

export type StoreTarget = "staging" | "production";

export interface StoreCliOptions {
  tenant: string;
  appliance: string;
  target: StoreTarget;
  ageRecipient: string;
  apply: boolean;
  confirmProduction: boolean;
}

/** The writes to `capture_scanner_keys`, through wrangler or a fake. */
export interface ScannerKeysDb {
  /** Runs a SQL file against the target's database. */
  runFile(path: string): void;
  /** The workspace's stored keys' revision, or null when it has no row. */
  revision(tenantId: string): number | null;
}

export interface StoreProviders {
  d1: D1Api;
  keychain: Pick<KeychainStore, "has" | "read">;
  keysDb: ScannerKeysDb;
  publicKeys: Record<StoreTarget, JsonWebKey | null>;
  now: () => number;
}

export function parseArgs(argv: string[]): StoreCliOptions {
  let tenant = "";
  let appliance = "";
  let target: string | null = null;
  let ageRecipient = "";
  let apply = false;
  let confirmProduction = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--apply") apply = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--tenant") tenant = value();
    else if (a === "--appliance") appliance = value();
    else if (a === "--target") target = value();
    else if (a === "--age-recipient") ageRecipient = value();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!tenant) throw new Error("--tenant is required");
  if (!SLUG_PATTERN.test(tenant)) throw new Error(`Not a tenant slug: ${tenant}`);
  if (!appliance) throw new Error("--appliance is required");
  if (!APPLIANCE_ID_PATTERN.test(appliance)) {
    throw new Error(`Not an appliance id: ${appliance} (lowercase letters, digits and hyphens, 1 to 32 characters)`);
  }
  if (appliance.endsWith("-read")) {
    throw new Error(`Not an appliance id: ${appliance} (an id may not end in -read, the read key's suffix)`);
  }
  if (target !== "staging" && target !== "production") {
    throw new Error("--target is required (staging or production)");
  }
  if (!ageRecipient) throw new Error("--age-recipient is required");
  if (!AGE_RECIPIENT_PATTERN.test(ageRecipient)) {
    throw new Error(`Not an age recipient: ${ageRecipient} (age1 and 58 lowercase letters or digits)`);
  }
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return { tenant, appliance, target, ageRecipient, apply, confirmProduction };
}

/** The upsert of a workspace's stored keys; see the module header. */
export function storeKeysStatement(row: {
  tenantId: string;
  applianceId: string;
  bucket: string;
  sealed: string;
  ageRecipient: string;
  now: number;
}): string {
  const values = [row.tenantId, row.applianceId, row.bucket, row.sealed, row.ageRecipient].map(escapeSql);
  return (
    "INSERT INTO capture_scanner_keys " +
    "(tenant_id, appliance_id, bucket, sealed, age_recipient, revision, stored_at, erased_at, erased_by)\n" +
    `VALUES (${values.join(", ")}, 1, ${Math.trunc(row.now)}, NULL, NULL)\n` +
    "ON CONFLICT(tenant_id) DO UPDATE SET appliance_id = excluded.appliance_id, bucket = excluded.bucket, " +
    "sealed = excluded.sealed, age_recipient = excluded.age_recipient, stored_at = excluded.stored_at, " +
    "erased_at = NULL, erased_by = NULL, revision = capture_scanner_keys.revision + 1;\n"
  );
}

/** Writes the statement to a 0600 file in a fresh directory, runs it, and removes the directory. */
function runStatementFile(sql: string, keysDb: ScannerKeysDb): void {
  const dir = mkdtempSync(join(tmpdir(), "fisqua-scanner-keys-"));
  try {
    const path = join(dir, "store.sql");
    writeFileSync(path, sql, { encoding: "utf8", mode: 0o600 });
    keysDb.runFile(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Seals and stores the workspace's appliance keys, or with no `apply` prints what it would store. */
export async function runStoreApplianceKeys(
  options: StoreCliOptions,
  providers: StoreProviders,
  log: (line: string) => void,
): Promise<void> {
  const { target, apply } = options;
  const publicJwk = providers.publicKeys[target];
  if (!publicJwk) {
    throw new ProvisionStop(
      `PAIRING_PUBLIC_KEYS.${target} is not set in app/lib/capture/pairing-public-keys.ts; ` +
        `run pairing-keypair.ts --target ${target} --apply first`,
    );
  }
  const { tenant, federation } = await resolveTenantStorage(options.tenant, providers.d1);
  const bucket = federation.pipeline_masters_bucket;
  const names = applianceKeyNames(tenant.slug, options.appliance, target);
  const write = keychainAccounts(names.write);
  const read = keychainAccounts(names.read);
  const accounts = [write.id, write.secret, read.id, read.secret];

  log(
    `Appliance keys to store for tenant ${tenant.slug} (${tenant.id}) in federation ${federation.slug}, ` +
      `appliance ${options.appliance}, target ${target}${apply ? "" : ", dry run"}`,
  );
  log("");
  log(`  upload key:         ${names.write}`);
  log(`  read key:           ${names.read}`);
  log(`  bucket:             ${bucket}`);
  log(`  age recipient:      ${options.ageRecipient}`);
  log(`  Keychain service:   ${KEYCHAIN_SERVICE}`);
  log(`  Keychain accounts:  ${accounts.join(", ")}`);

  const missing = accounts.filter((a) => !providers.keychain.has(KEYCHAIN_SERVICE, a));
  if (missing.length > 0) {
    throw new ProvisionStop(
      `The Keychain has no ${KEYCHAIN_SERVICE} item for: ${missing.join(", ")}. ` +
        "Mint the keys with provision-appliance-key.ts, or mint under a new appliance id if their secrets are gone",
    );
  }
  if (!apply) {
    log("");
    log(`  [store] would seal both key pairs for ${tenant.id} on ${target} and write its capture_scanner_keys row`);
    log("\nDry run: nothing was written. Run with --apply to write.");
    return;
  }

  const value = (account: string): string => {
    const v = providers.keychain.read(KEYCHAIN_SERVICE, account);
    if (!v) throw new ProvisionStop(`The Keychain has no value for ${KEYCHAIN_SERVICE} / ${account}`);
    return v;
  };
  const sealed = await sealKeys(
    publicJwk,
    {
      writeKey: { keyId: value(write.id), applicationKey: value(write.secret) },
      readKey: { keyId: value(read.id), applicationKey: value(read.secret) },
    },
    { tenantId: tenant.id, environment: target },
  );
  runStatementFile(
    storeKeysStatement({
      tenantId: tenant.id,
      applianceId: options.appliance,
      bucket,
      sealed,
      ageRecipient: options.ageRecipient,
      now: providers.now(),
    }),
    providers.keysDb,
  );
  let revision: number | null;
  try {
    revision = providers.keysDb.revision(tenant.id);
  } catch (err) {
    throw new ProvisionStop(
      `The keys for ${tenant.slug} on ${target} were stored, but the revision could not be read back: ` +
        `${(err as Error).message}. Do not run the command again for this; read capture_scanner_keys for ` +
        `tenant ${tenant.id} instead`,
    );
  }
  log("");
  log(
    `  [store] stored ${names.write} and ${names.read}, sealed, for ${tenant.slug} on ${target}; ` +
      `revision ${revision ?? "(not read back)"}`,
  );
  log(`  Codes approved for ${tenant.slug} and not yet collected are now void; the unit asks for a new code.`);
}

/** `capture_scanner_keys` through `wrangler d1 execute` on the target's database. */
export function wranglerScannerKeys(target: StoreTarget, run: CommandRunner): ScannerKeysDb {
  return {
    runFile(path) {
      runD1([...d1Args(target), "--file", path, "--yes"], { exec: run });
    },
    revision(tenantId) {
      const sets = runD1Json<{ revision: number }>(
        [
          ...d1Args(target),
          "--json",
          "--command",
          `SELECT revision FROM capture_scanner_keys WHERE tenant_id = ${escapeSql(tenantId)}`,
        ],
        { exec: run },
      );
      const row = sets[0]?.results?.[0];
      return row ? Number(row.revision) : null;
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runStoreApplianceKeys(
    options,
    {
      d1: wranglerD1(options.target, execCommand),
      keychain: macKeychainStore,
      keysDb: wranglerScannerKeys(options.target, execCommand),
      publicKeys: PAIRING_PUBLIC_KEYS,
      now: () => Date.now(),
    },
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
