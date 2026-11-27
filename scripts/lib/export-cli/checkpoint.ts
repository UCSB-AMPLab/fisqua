/**
 * Scripts — the export's checkpoint and page files
 *
 * This module deals with an export's checkpoint and page files. (The lock,
 * one export at a time against each target, is a TCP port the operating
 * system holds: `./lock.ts`.)
 *
 * Each `--out` folder holds one export. `export-checkpoint.json` there
 * records the arguments, and for each phase of the set (`./sets.ts`)
 * whether it is done, where its reading stands (the last id read, and
 * for a phase read in chunks of ids, the chunk), the rows it has kept
 * and the size in bytes of its page file. Rows are appended to the page
 * file (`.export-parts/<name>.jsonl`, named by `fileSafeName`, one JSON
 * row a line) before the
 * checkpoint is written, so a run stopped between the two leaves bytes
 * past the recorded size; the next run truncates every page file to the
 * size the checkpoint records before reading on, and so reads every
 * row once. The checkpoint is written to a temporary file and renamed
 * over the old one.
 *
 * @version v0.9.0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Row } from "./reader";

/** A refusal before anything is read, or a checkpoint that does not belong to this run. */
export class ExportRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportRefusal";
  }
}

// ---------------------------------------------------------------------------
// The checkpoint
// ---------------------------------------------------------------------------

export interface CheckpointArgs {
  set: string;
  target: string;
  tenant: string;
  fonds: string[];
}

export interface PhaseState {
  done: boolean;
  /** The last id read in the current page run, or "" at its start. */
  after: string;
  /** For a phase read in chunks of ids: the chunk being read. */
  chunk: number;
  pages: number;
  rows: number;
  bytes: number;
}

export interface RunRecord {
  startedAt: string;
  endedAt: string | null;
  statements: number;
  outcome: "running" | "complete" | "stopped";
  reason?: string;
}

export interface Checkpoint {
  format: 1;
  args: CheckpointArgs;
  phases: Record<string, PhaseState>;
  runs: RunRecord[];
  complete: boolean;
}

export const CHECKPOINT_FILE = "export-checkpoint.json";
export const PARTS_DIR = ".export-parts";

export const sameArgs = (a: CheckpointArgs, b: CheckpointArgs) =>
  a.set === b.set && a.target === b.target && a.tenant === b.tenant && a.fonds.join("\n") === b.fonds.join("\n");

/** The checkpoint and page files of one `--out` folder. */
export class Store {
  private readonly cache = new Map<string, Row[]>();

  constructor(readonly out: string) {}

  get checkpointPath(): string {
    return path.join(this.out, CHECKPOINT_FILE);
  }

  load(): Checkpoint | null {
    if (!fs.existsSync(this.checkpointPath)) return null;
    const cp = JSON.parse(fs.readFileSync(this.checkpointPath, "utf8")) as Checkpoint;
    if (cp.format !== 1) throw new ExportRefusal(`${this.checkpointPath} is not a checkpoint this command reads`);
    return cp;
  }

  save(cp: Checkpoint): void {
    fs.mkdirSync(this.out, { recursive: true });
    const tmp = `${this.checkpointPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cp, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, this.checkpointPath);
  }

  partPath(phase: string): string {
    return path.join(this.out, PARTS_DIR, `${fileSafeName(phase)}.jsonl`);
  }

  /** Cuts the page file back to `bytes`, dropping rows written after the checkpoint was. */
  truncate(phase: string, bytes: number): void {
    const file = this.partPath(phase);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      if (bytes > 0) throw new ExportStopFile(`${file} is missing; the checkpoint records ${bytes} bytes in it`);
      fs.writeFileSync(file, "", "utf8");
      return;
    }
    const size = fs.statSync(file).size;
    if (size < bytes) throw new ExportStopFile(`${file} holds ${size} bytes; the checkpoint records ${bytes}`);
    if (size > bytes) fs.truncateSync(file, bytes);
    this.cache.delete(phase);
  }

  /** Appends rows to the page file and returns its size afterwards. */
  append(phase: string, rows: Row[]): number {
    const file = this.partPath(phase);
    if (rows.length > 0) fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    this.cache.delete(phase);
    return fs.statSync(file).size;
  }

  /** Every row kept by a phase. */
  read(phase: string): Row[] {
    const cached = this.cache.get(phase);
    if (cached) return cached;
    const text = fs.readFileSync(this.partPath(phase), "utf8");
    const rows = text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Row);
    this.cache.set(phase, rows);
    return rows;
  }

  removeParts(): void {
    fs.rmSync(path.join(this.out, PARTS_DIR), { recursive: true, force: true });
  }
}

/** The longest file name the export writes, in bytes; a longer one is refused before anything is read. */
export const MAX_FILE_NAME_BYTES = 200;

const hexOf = (text: string) => Buffer.from(text, "utf8").toString("hex");
const slugOf = (text: string) => text.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * A file name for a phase, injective by construction. A phase without a
 * fonds (`tenant`, `links`, …) keeps its own name, made only of letters
 * and `-`. A phase of a fonds, `<kind>:<code>`, is `<kind>@<slug>@<hex>`:
 * the hex is the full hex of the code's UTF-8 bytes, which alone tells
 * two codes apart, and the slug is a readable start of the code, cut so
 * the file name with `suffix` stays within `MAX_FILE_NAME_BYTES` (it may
 * be cut to nothing). `@` never appears in a kind, a slug or a hex, so a
 * name splits back into its parts. Throws when even the name without a
 * slug would be too long.
 */
export function fileSafeName(name: string, suffix = ".jsonl"): string {
  const colon = name.indexOf(":");
  if (colon < 0) {
    if (!/^[a-z][a-z-]*$/.test(name)) throw new ExportRefusal(`A phase name the export cannot use as a file name: ${name}`);
    return name;
  }
  const kind = name.slice(0, colon);
  const code = name.slice(colon + 1);
  const hex = hexOf(code);
  const bare = `${kind}@@${hex}`;
  const room = MAX_FILE_NAME_BYTES - Buffer.byteLength(bare + suffix);
  if (room < 0) {
    throw new ExportRefusal(
      `The reference code ${code} is too long for the export's file names (${Buffer.byteLength(bare + suffix)} bytes; ` +
        `the limit is ${MAX_FILE_NAME_BYTES} bytes); nothing was read`,
    );
  }
  return `${kind}@${slugOf(code).slice(0, room)}@${hex}`;
}

/** A file name for a short form of a fonds code: as it is when it is safe, else `fileSafeName` of it. */
export function fileShortName(short: string, suffix: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(short) && Buffer.byteLength(short + suffix) <= MAX_FILE_NAME_BYTES) return short;
  return fileSafeName(`fonds:${short}`, suffix);
}

/** A page file that does not match its checkpoint: the folder needs looking at before a resume. */
export class ExportStopFile extends ExportRefusal {}

// @version v0.9.0
