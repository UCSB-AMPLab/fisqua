/**
 * Tests — the cron triggers in wrangler.jsonc
 *
 * This suite checks the cron triggers each deployment declares in
 * `wrangler.jsonc`. Production runs the sweeps every fifteen minutes and
 * the duplicate recheck every five. Staging inherits `triggers` unless it
 * sets its own, and the sweeps must not run there, so its block lists the
 * recheck cron and nothing else.
 *
 * The file is JSON with comments, so it is read with TypeScript's
 * config-file parser, as the pipeline environment suite does.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DUPLICATE_RECHECK_CRON, SWEEP_CRON } from "../../app/lib/scheduled-dispatch";

interface EnvConfig { triggers?: { crons?: string[] } }
interface WranglerConfig extends EnvConfig { env?: Record<string, EnvConfig> }

const path = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
if (parsed.error) throw new Error(`wrangler.jsonc did not parse: ${String(parsed.error.messageText)}`);
const config = parsed.config as WranglerConfig;

describe("cron triggers in wrangler.jsonc", () => {
  it("runs only the duplicate recheck on staging", () => {
    expect(config.env?.staging?.triggers?.crons).toEqual([DUPLICATE_RECHECK_CRON]);
  });

  it("runs the sweeps and the duplicate recheck in production", () => {
    expect(config.triggers?.crons).toEqual([SWEEP_CRON, DUPLICATE_RECHECK_CRON]);
  });
});

// @version v0.9.0
