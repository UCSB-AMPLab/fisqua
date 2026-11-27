/**
 * Scripts — the operator's macOS Keychain, read and written without exposing a value
 *
 * This module gives the operator commands three operations on the macOS
 * login Keychain's generic passwords, as a `KeychainStore`, so that a
 * command takes them as a provider and its tests run against an
 * in-memory one:
 *
 *   - `has(service, account)` runs `security find-generic-password`
 *     without `-w`, which reports whether the item exists and does not
 *     decrypt its value;
 *   - `read(service, account)` runs it with `-w` and returns the value
 *     from stdout, without its trailing newline, or null when the item
 *     does not exist (exit 44);
 *   - `add(service, account, value)` adds an item and refuses one that
 *     exists (no `-U`).
 *
 * `writeGenericPassword` is the one writer both `add` and the appliance
 * key command (`macKeychain` in `appliance-key.ts`) go through; it takes
 * `-U` as an option, so the appliance command can replace an item.
 *
 * No value is ever an argument of a process, where any user of the
 * machine could read it in the process list. `add` runs `security -i`
 * and gives it one command on stdin (`addGenericPasswordLine`), with the
 * value as hexadecimal under `-X`, so no quoting of the value is needed.
 * The service and account are passed on that line unquoted and must
 * therefore be letters, digits, dots, underscores and hyphens. `read`
 * receives the value on stdout. Every error names the service, the
 * account and the exit status, never the value, and the output of
 * `security` is discarded except the value `read` asks for.
 *
 * `security` is started through a `SecurityRun`, which takes the argument
 * list and the stdin text, so that tests see both and never reach the
 * real Keychain.
 *
 * @version v0.9.0
 */

import { execFileSync } from "node:child_process";
import { ProvisionStop } from "./tenant-storage";

/** Generic passwords in the operator's Keychain, by service and account. */
export interface KeychainStore {
  /** Whether an item exists, without reading its value. */
  has(service: string, account: string): boolean;
  /** The item's value, or null when there is no such item. */
  read(service: string, account: string): string | null;
  /** Adds an item; throws when it exists. */
  add(service: string, account: string, value: string): void;
}

/** What `security -i` can take unquoted as a service or account. */
const PLAIN_NAME = /^[A-Za-z0-9._-]+$/;

/** `security` exits 44 when no item matches. */
const NOT_FOUND = 44;

function checkName(what: string, name: string): void {
  if (!PLAIN_NAME.test(name)) {
    throw new ProvisionStop(`Not a Keychain ${what} this command can pass: ${JSON.stringify(name)}`);
  }
}

/** The one line given to `security -i` on stdin to add an item, its value as hexadecimal. */
export function addGenericPasswordLine(
  service: string,
  account: string,
  value: string,
  update = false,
): string {
  checkName("service", service);
  checkName("account", account);
  const hex = Buffer.from(value, "utf8").toString("hex");
  return `add-generic-password${update ? " -U" : ""} -s ${service} -a ${account} -X ${hex}\n`;
}

/** Starts `security` with an argument list and the text to give it on stdin; throws on a non-zero exit. */
export type SecurityRun = (args: string[], input: string) => void;

/** `SecurityRun` over `execFileSync`: stdin piped, all output discarded. */
export const runSecurity: SecurityRun = (args, input) => {
  execFileSync("security", args, { input, stdio: ["pipe", "ignore", "ignore"] });
};

function statusOf(err: unknown): number | null {
  const status = (err as { status?: number | null }).status;
  return typeof status === "number" ? status : null;
}

function failure(action: string, service: string, account: string, status: number | null): ProvisionStop {
  return new ProvisionStop(
    `security ${action} failed for the Keychain service ${service}, account ${account}` +
      (status === null ? "" : ` (exit ${status})`),
  );
}

/**
 * Adds a generic password through `security -i`, the value only on stdin
 * (as hexadecimal). With `update`, an item that exists is replaced.
 */
export function writeGenericPassword(
  run: SecurityRun,
  service: string,
  account: string,
  value: string,
  update: boolean,
): void {
  const line = addGenericPasswordLine(service, account, value, update);
  try {
    run(["-i"], line);
  } catch (err) {
    throw failure("add-generic-password", service, account, statusOf(err));
  }
}

/** The login Keychain through `security`; see the module header. */
export const macKeychainStore: KeychainStore = {
  has(service, account) {
    checkName("service", service);
    checkName("account", account);
    try {
      execFileSync("security", ["find-generic-password", "-s", service, "-a", account], { stdio: "ignore" });
      return true;
    } catch (err) {
      const status = statusOf(err);
      if (status === NOT_FOUND) return false;
      throw failure("find-generic-password", service, account, status);
    }
  },

  read(service, account) {
    checkName("service", service);
    checkName("account", account);
    try {
      const out = execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.endsWith("\n") ? out.slice(0, -1) : out;
    } catch (err) {
      const status = statusOf(err);
      if (status === NOT_FOUND) return null;
      throw failure("find-generic-password", service, account, status);
    }
  },

  add(service, account, value) {
    writeGenericPassword(runSecurity, service, account, value, false);
  },
};

// @version v0.9.0
