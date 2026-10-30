/**
 * Scripts — a capture appliance's upload and read keys
 *
 * This module deals with the two B2 keys a capture appliance (Captua)
 * holds: the key it uploads its captures with, and a separate key that
 * reads them back. The appliance works offline at the venue and, when
 * a collection is handed over, uploads each volume's images to the
 * tenant's prefix in its federation's masters bucket, under
 * `{slug}/<stem>/captures/` and `{slug}/<stem>/previews/`, the keys the
 * Captua exchange contract names. Its key may list and write there and
 * nothing else: `listBuckets`, `listFiles` and `writeFiles`, limited to
 * the masters bucket and the prefix `{slug}/`, with no `readFiles` and
 * no
 * `deleteFiles`. `listFiles` is what lets the uploader see
 * that an object is already at a key, with its SHA1, before it writes.
 *
 * The read key (`access: "read"`, `--access read`) lets an admin restore
 * on the appliance a volume whose images were freed from its card after
 * upload. It may list and read and nothing else: `listBuckets`,
 * `listFiles` and `readFiles` (`B2_APPLIANCE_READ_CAPABILITIES`), on the
 * same masters bucket and prefix, with no `writeFiles` and no
 * `deleteFiles`. The prefix `{slug}/` covers every volume of the tenant,
 * not only the ones this appliance captured, and `{slug}/db-backups/`,
 * where the tenant's database dumps are kept age-encrypted. A unit whose
 * read key is compromised can therefore read its tenant's whole archive
 * (an accepted risk); it still cannot write or
 * delete. The two keys are separate, and each is checked only against
 * its own name and capabilities: a key named for one access and limited
 * as the other stops the command.
 *
 * `provisionApplianceKey(options, providers, log)`, for either access, resolves the tenant
 * and its federation's complete storage record as the tenant step does
 * (`resolveTenantStorage`), finds the masters bucket the record names
 * (`findRecordBucket`), and then:
 *
 *   - with no key of the appliance's name in the B2 account, issues one
 *     (`[create]`), reads it back from `b2_list_keys` by its id and
 *     stops unless B2 reports exactly the wanted capabilities, bucket and
 *     prefix, then stores its id and secret in the operator's Keychain;
 *   - with keys of that name all limited as they should be, issues
 *     nothing (`[exists]`): the secret was handed over when the key was
 *     made and cannot be read back;
 *   - with any key of that name limited otherwise, stops and lists every
 *     key of the name by id, bucket, prefix and capabilities, for the
 *     stale ones to be deleted by hand. It never deletes a key.
 *
 * Names. The upload key is `fisqua-{slug}[-staging]-appliance-{id}` and
 * the read key `fisqua-{slug}[-staging]-appliance-{id}-read`
 * (`applianceKeyName`), from the tenant's slug as the runner keys are,
 * with `-staging` on staging, and the appliance's short id: lowercase
 * letters, digits and hyphens, 1 to 32 characters
 * (`APPLIANCE_ID_PATTERN`), not ending in `-read`, so that no
 * appliance's upload key can carry another appliance's read key name.
 * Key names are compared whole, never as prefixes. The masters bucket is whatever the
 * federation's record names, the same in both environments when the
 * record says so.
 *
 * The secret. The key's id and secret go to the macOS Keychain, service
 * `fisqua-appliance` (`KEYCHAIN_SERVICE`), accounts `{key name}-id` and
 * `{key name}-secret` (`keychainAccounts`), from which the operator
 * hands them to the appliance. `macKeychain` writes them with
 * `security add-generic-password -U`, the value passed as an argument
 * through `execFileSync` (never a shell string), its output discarded,
 * and an error that names the account and exit status but not the
 * command line, which holds the value. The log carries the key's name,
 * its id (which is not secret) and the two account names, never the
 * secret. The writer is part of the providers, so the tests never touch
 * the real Keychain.
 *
 * A dry run, the default, reads the record, the bucket and the account's
 * keys and prints what it would do. Without B2 credentials a dry run
 * prints the key as unchecked, and `--apply` stops. Nothing is written
 * to D1 or GitHub.
 *
 * @version v0.8.0
 */

import { execFileSync } from "node:child_process";
import {
  findRecordBucket,
  nameBase,
  ProvisionStop,
  resolveTenantStorage,
  SLUG_PATTERN,
  type B2Api,
  type B2KeyInfo,
  type D1Api,
  type Log,
  type Target,
} from "./tenant-storage";

/** A short appliance id: lowercase letters, digits and hyphens, 1 to 32 characters. */
export const APPLIANCE_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

/** List and write under the tenant's prefix: no `readFiles`, no `deleteFiles`. */
export const B2_APPLIANCE_CAPABILITIES = ["listBuckets", "listFiles", "writeFiles"];

/** List and read under the tenant's prefix: no `writeFiles`, no `deleteFiles`. */
export const B2_APPLIANCE_READ_CAPABILITIES = ["listBuckets", "listFiles", "readFiles"];

/** What an appliance key may do: upload (`write`) or read back (`read`). */
export type ApplianceAccess = "write" | "read";

export const APPLIANCE_ACCESS_VALUES: readonly ApplianceAccess[] = ["write", "read"];

/** The capabilities, name suffix and log wording of each access. */
const ACCESS: Record<ApplianceAccess, { capabilities: string[]; suffix: string; verbs: string; noun: string }> = {
  write: { capabilities: B2_APPLIANCE_CAPABILITIES, suffix: "", verbs: "list and write", noun: "appliance" },
  read: { capabilities: B2_APPLIANCE_READ_CAPABILITIES, suffix: "-read", verbs: "list and read", noun: "appliance read key" },
};

/** The Keychain service the appliance keys are stored under. */
export const KEYCHAIN_SERVICE = "fisqua-appliance";

/** Stores one value in the operator's Keychain under a service and account. */
export type KeychainWriter = (service: string, account: string, value: string) => void;

export interface ApplianceProviders {
  b2: B2Api | null;
  d1: D1Api;
  keychain: KeychainWriter;
}

export interface ApplianceStepOptions {
  /** The tenant's slug. */
  slug: string;
  /** The appliance's short id. */
  appliance: string;
  target: Target;
  apply: boolean;
  /** Which key: the upload key (`write`, the default) or the read key. */
  access?: ApplianceAccess;
}

export function checkApplianceId(id: string): void {
  if (!APPLIANCE_ID_PATTERN.test(id)) {
    throw new ProvisionStop(
      `Not an appliance id: ${id} (lowercase letters, digits and hyphens, 1 to 32 characters)`,
    );
  }
  if (id.endsWith("-read")) {
    throw new ProvisionStop(`Not an appliance id: ${id} (an id may not end in -read, the read key's suffix)`);
  }
}

export function checkApplianceAccess(access: string): asserts access is ApplianceAccess {
  if (!(APPLIANCE_ACCESS_VALUES as readonly string[]).includes(access)) {
    throw new ProvisionStop(`Not an appliance key access: ${access} (write or read)`);
  }
}

/** The appliance's key name, from the tenant's slug, the appliance's id and the access. */
export function applianceKeyName(
  tenantSlug: string,
  applianceId: string,
  target: Target,
  access: ApplianceAccess = "write",
): string {
  if (!SLUG_PATTERN.test(tenantSlug)) throw new ProvisionStop(`Not a tenant slug: ${tenantSlug}`);
  checkApplianceId(applianceId);
  checkApplianceAccess(access);
  return `fisqua-${nameBase(tenantSlug, target)}-appliance-${applianceId}${ACCESS[access].suffix}`;
}

/** The Keychain accounts that hold a key's id and secret. */
export function keychainAccounts(keyName: string): { id: string; secret: string } {
  return { id: `${keyName}-id`, secret: `${keyName}-secret` };
}

/** Writes to the macOS login Keychain through `security`, the value never logged. */
export const macKeychain: KeychainWriter = (service, account, value) => {
  try {
    execFileSync("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value], {
      stdio: "ignore",
    });
  } catch (err) {
    // The error's message repeats the command line, which holds the value.
    const status = (err as { status?: number | null }).status;
    throw new ProvisionStop(
      `security add-generic-password failed for the Keychain account ${account}` +
        (status == null ? "" : ` (exit ${status})`),
    );
  }
};

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/** Whether a key is limited exactly as the appliance's key of that access should be. */
function fits(k: B2KeyInfo, bucketId: string, prefix: string, capabilities: string[]): boolean {
  return k.bucketId === bucketId && (k.namePrefix ?? "") === prefix && sameSet(k.capabilities, capabilities);
}

function describe(k: B2KeyInfo): string {
  return (
    `key ${k.keyId} (bucket ${k.bucketId ?? "(any)"}, prefix ${k.namePrefix || "(none)"}, ` +
    `capabilities ${k.capabilities.join(", ") || "(none)"})`
  );
}

/**
 * Mints one appliance's upload key or read key in the tenant's part of
 * its federation's masters bucket, and stores its id and secret in the
 * Keychain. Writes nothing to D1 or GitHub.
 */
export async function provisionApplianceKey(
  options: ApplianceStepOptions,
  providers: ApplianceProviders,
  log: Log,
): Promise<void> {
  const { apply, target } = options;
  if (target === "local") {
    throw new ProvisionStop("The appliance key is issued in the B2 account; use --target staging or production");
  }
  checkApplianceId(options.appliance);
  const access = options.access ?? "write";
  checkApplianceAccess(access);
  const { capabilities, verbs, noun } = ACCESS[access];
  const { tenant, federation } = await resolveTenantStorage(options.slug, providers.d1);
  const name = applianceKeyName(tenant.slug, options.appliance, target, access);
  const prefix = `${tenant.slug}/`;
  const bucket = federation.pipeline_masters_bucket;
  const accounts = keychainAccounts(name);
  const label = `B2 key, ${verbs}, limited to ${bucket}/${prefix} (${noun})`;
  const { b2 } = providers;

  log(
    `Appliance ${access === "read" ? "read " : ""}key for tenant ${tenant.slug} (${tenant.id}) in federation ${federation.slug}, ` +
      `appliance ${options.appliance}, target ${target}${apply ? "" : ", dry run"}`,
  );
  log("");
  log("Names");
  log(`  masters (B2, federation's):   ${bucket}/${prefix}`);
  log(`  ${access === "read" ? "appliance read key:          " : "appliance key:               "} ${name}`);
  log(`  capabilities:                 ${capabilities.join(", ")}`);
  log(`  Keychain service:             ${KEYCHAIN_SERVICE}`);
  log(`  Keychain accounts:            ${accounts.id}, ${accounts.secret}`);
  if (apply && !b2) throw new ProvisionStop("--apply needs credentials for: B2");

  log("");
  log("1. Masters bucket");
  if (!b2) {
    log(`  [unchecked] B2 masters bucket ${bucket} (no B2 credentials)`);
    log("");
    log(`2. Appliance ${access === "read" ? "read " : ""}key`);
    log(`  [unchecked] ${name}: ${label} (no B2 credentials)`);
    return;
  }
  const bucketId = await findRecordBucket(b2, bucket, "masters bucket", log);

  log("");
  log(`2. Appliance ${access === "read" ? "read " : ""}key`);
  const named = (await b2.keys()).filter((k) => k.keyName === name);
  if (named.length > 0) {
    if (named.every((k) => fits(k, bucketId, prefix, capabilities))) {
      log(`  [exists] ${name}: ${label}; key ${named.map((k) => k.keyId).join(", ")}, nothing issued`);
      return;
    }
    throw new ProvisionStop(
      `The B2 account holds keys named ${name} that are not limited to ${capabilities.join(", ")} ` +
        `on ${bucket}/${prefix}: ${named.map(describe).join("; ")}. The command deletes no key: delete the ` +
        "stale key(s) by hand and run it again",
    );
  }
  if (!apply) {
    log(`  [create] would issue ${name}: ${label}, and store its id and secret in the Keychain`);
    return;
  }
  const key = await b2.createKey(name, capabilities, bucketId, prefix);
  const reported = (await b2.keys()).find((k) => k.keyId === key.keyId);
  if (!reported || reported.keyName !== name || !fits(reported, bucketId, prefix, capabilities)) {
    throw new ProvisionStop(
      `B2 ${reported ? `reports the new key as ${describe(reported)}` : `does not list the new key ${key.keyId}`}, ` +
        `not ${capabilities.join(", ")} on bucket ${bucketId}, prefix ${prefix}. ` +
        `Nothing was stored in the Keychain; delete key ${key.keyId} (${name}) by hand`,
    );
  }
  try {
    providers.keychain(KEYCHAIN_SERVICE, accounts.id, key.keyId);
    providers.keychain(KEYCHAIN_SERVICE, accounts.secret, key.secret);
  } catch (err) {
    throw new ProvisionStop(
      `${(err as Error).message}. Its secret cannot be read back: delete key ${key.keyId} (${name}) by hand ` +
        "and run the command again",
    );
  }
  log(
    `  [create] issued ${name}: ${label}; key ${key.keyId}, B2 reports ` +
      `${capabilities.join(", ")} on ${bucket}/${prefix}`,
  );
  log(`  [create] stored its id and secret in the Keychain, service ${KEYCHAIN_SERVICE}, accounts ${accounts.id} and ${accounts.secret}`);
}

// @version v0.8.0
