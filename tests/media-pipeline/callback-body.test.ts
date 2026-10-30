/**
 * Tests — media pipeline callback bodies
 *
 * This suite pins the two bodies the runner posts back to Fisqua: the
 * per-volume outcome report and the chunk-complete report.
 *
 *   - the documented example of each passes, as do the bodies the runner
 *     actually sends that differ from it: `qc` and `verification` null on
 *     an aborted or halted volume, an empty `runner`, extra runner
 *     version keys, and every stage `not_reached` on a refused volume;
 *   - each rule the handler relies on has one rejecting case: the outcome
 *     and stage vocabularies, the pairing of `halted` with the systemic
 *     error classes and of `aborted` with the rest, the flag rules that
 *     keep the review-item insert inside its constraints, the attempt
 *     format, the two-way verification method, and the closed objects;
 *   - the chunk-complete body requires `attempt` and `halted_volume_ids`,
 *     refuses duplicates and a halted volume missing from the unreported
 *     list, and gives the documented idempotency key.
 *
 * Each rejecting case is a named change to one of the fixtures in
 * `tests/fixtures/media-pipeline/`.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import {
  volumeCallbackBodySchema,
  chunkCompleteBodySchema,
  chunkIdempotencyKey,
} from "../../app/lib/pipeline/callback-body";
import preparedFixture from "../fixtures/media-pipeline/callback-prepared.json";
import reviewFixture from "../fixtures/media-pipeline/callback-review-pending.json";
import refusedFixture from "../fixtures/media-pipeline/callback-refused.json";
import chunkFixture from "../fixtures/media-pipeline/callback-chunk-complete.json";

type Json = Record<string, any>;

const prepared = (): Json => structuredClone(preparedFixture) as Json;
const review = (): Json => structuredClone(reviewFixture) as Json;
const refused = (): Json => structuredClone(refusedFixture) as Json;
const chunk = (): Json => structuredClone(chunkFixture) as Json;

function aborted(cls: string, base: Json = prepared()): Json {
  base.outcome = "aborted";
  base.error = { class: cls, stage: "render", message: "it failed", page_keys: ["p0003"] };
  return base;
}

function halted(cls: string, base: Json = prepared()): Json {
  const body = aborted(cls, base);
  body.outcome = "halted";
  return body;
}

function flag(i: number): Json {
  return { page_key: `p${i}`, stage: "render", code: "edge_overflow", summary: "A flag." };
}

const accepts = (body: unknown) => volumeCallbackBodySchema.safeParse(body).success;

describe("per-volume callback body: accepted", () => {
  it("accepts the documented prepared example and a review-pending body", () => {
    expect(accepts(prepared())).toBe(true);
    expect(accepts(review())).toBe(true);
  });

  it("accepts the runner's refused-entry body", () => {
    const body = refused();
    expect(body.runner).toEqual({});
    expect(accepts(body)).toBe(true);
  });

  it("accepts null qc and verification on aborted and halted bodies", () => {
    const qcAbort = aborted("qc");
    qcAbort.qc = null;
    qcAbort.verification = null;
    expect(accepts(qcAbort)).toBe(true);

    const qcObject = aborted("qc");
    qcObject.verification = null;
    expect(accepts(qcObject)).toBe(true);

    const destination = halted("destination");
    destination.qc = null;
    destination.verification = null;
    expect(accepts(destination)).toBe(true);
  });

  it("accepts runner keys beyond the documented example", () => {
    const body = prepared();
    body.runner.versions.pdftoppm = "24.02.0";
    body.runner.extra = { anything: true };
    expect(accepts(body)).toBe(true);
  });

  it("accepts a truncated flag list of exactly 500", () => {
    const body = review();
    body.flags = Array.from({ length: 500 }, (_, i) => flag(i));
    body.flags_truncated = true;
    expect(accepts(body)).toBe(true);
  });

  it("keeps stage fields it does not name", () => {
    const parsed = volumeCallbackBodySchema.parse(prepared());
    expect(parsed.stages.tile).toEqual(prepared().stages.tile);
    expect(parsed.runner).toEqual(prepared().runner);
  });
});

describe("per-volume callback body: error class pairing", () => {
  it("pairs halted with the systemic classes only", () => {
    expect(accepts(halted("auth"))).toBe(true);
    expect(accepts(halted("source_pull"))).toBe(true);
    expect(accepts(halted("destination"))).toBe(true);
    expect(accepts(halted("image"))).toBe(false);
    expect(accepts(halted("fixity"))).toBe(false);
  });

  it("pairs aborted with the non-systemic classes only", () => {
    expect(accepts(aborted("spec"))).toBe(true);
    expect(accepts(aborted("fixity"))).toBe(true);
    expect(accepts(aborted("auth"))).toBe(false);
    expect(accepts(aborted("source_pull"))).toBe(false);
    expect(accepts(aborted("destination"))).toBe(false);
  });
});

const REJECTED: Record<string, () => Json> = {
  "unknown outcome": () => ({ ...prepared(), outcome: "completed" }),
  "a missing stage": () => {
    const b = prepared();
    delete b.stages.verify;
    return b;
  },
  "an unknown stage": () => {
    const b = prepared();
    b.stages.publish = { status: "ok" };
    return b;
  },
  "an unknown stage status": () => {
    const b = prepared();
    b.stages.pull.status = "done";
    return b;
  },
  "skipped without a reason": () => {
    const b = prepared();
    b.stages.ocr = { status: "skipped" };
    return b;
  },
  "prepared with an error": () => ({
    ...prepared(),
    error: { class: "image", stage: "render", message: "m", page_keys: [] },
  }),
  "prepared with a false qc value": () => {
    const b = prepared();
    b.qc.info_json_complete = false;
    return b;
  },
  "review pending with a false qc value": () => {
    const b = review();
    b.qc.homepage_conformant = false;
    return b;
  },
  "prepared with null qc": () => ({ ...prepared(), qc: null }),
  "review pending with null verification": () => ({ ...review(), verification: null }),
  "a body without the qc key": () => {
    const b = refused();
    delete b.qc;
    return b;
  },
  "a body without the verification key": () => {
    const b = refused();
    delete b.verification;
    return b;
  },
  "aborted without an error": () => ({ ...aborted("image"), error: null }),
  "an unknown error class": () => aborted("timeout"),
  "a Fisqua-only error class": () => aborted("token_expired"),
  "prepared with flags": () => ({ ...prepared(), flags: [flag(1)] }),
  "prepared with flags truncated": () => ({ ...prepared(), flags_truncated: true }),
  "review pending with no flags": () => ({ ...review(), flags: [] }),
  "more than 500 flags": () => ({
    ...review(),
    flags: Array.from({ length: 501 }, (_, i) => flag(i)),
    flags_truncated: true,
  }),
  "truncated with fewer than 500 flags": () => ({ ...review(), flags_truncated: true }),
  "a flag with an extra key": () => ({ ...review(), flags: [{ ...flag(1), evidence: {} }] }),
  "a flag with a runner-only stage": () => ({
    ...review(),
    flags: [{ ...flag(1), stage: "upload" }],
  }),
  "a flag with an empty page key": () => ({ ...review(), flags: [{ ...flag(1), page_key: "" }] }),
  "a flag with an empty code": () => ({ ...review(), flags: [{ ...flag(1), code: "" }] }),
  "a flag with an empty summary": () => ({ ...review(), flags: [{ ...flag(1), summary: "" }] }),
  "a repeated flag": () => ({ ...review(), flags: [flag(1), { ...flag(1), summary: "Again." }] }),
  "a bad attempt": () => ({ ...prepared(), attempt: "11223344" }),
  "one-way verification": () => {
    const b = prepared();
    b.verification.method = "rclone-check-one-way";
    return b;
  },
  "an unknown top-level key": () => ({ ...prepared(), manifest: {} }),
  "an unknown outputs key": () => {
    const b = prepared();
    b.outputs.manifest = {};
    return b;
  },
  "an unknown error key": () => {
    const b = aborted("image");
    b.error.trace = "...";
    return b;
  },
  "an unknown qc key": () => {
    const b = prepared();
    b.qc.extra = true;
    return b;
  },
  "an unknown verification key": () => {
    const b = prepared();
    b.verification.extra = 1;
    return b;
  },
  "a wrong spec version": () => ({ ...prepared(), spec_version: 2 }),
};

describe("per-volume callback body: rejected", () => {
  it.each(Object.entries(REJECTED))("refuses %s", (_name, make) => {
    expect(accepts(make())).toBe(false);
  });
});

describe("chunk-complete body", () => {
  const acceptsChunk = (body: unknown) => chunkCompleteBodySchema.safeParse(body).success;

  it("accepts the documented example, with halted volumes listed as unreported", () => {
    expect(acceptsChunk(chunk())).toBe(true);
    expect(
      acceptsChunk({
        ...chunk(),
        conclusion: "failure",
        unreported_volume_ids: ["pv_01", "pv_02"],
        halted_volume_ids: ["pv_02"],
      }),
    ).toBe(true);
  });

  const rejected: Record<string, () => Json> = {
    "a body without attempt": () => {
      const b = chunk();
      delete b.attempt;
      return b;
    },
    "a body without halted_volume_ids": () => {
      const b = chunk();
      delete b.halted_volume_ids;
      return b;
    },
    "an unknown key": () => ({ ...chunk(), extra: 1 }),
    "conclusion skipped": () => ({ ...chunk(), conclusion: "skipped" }),
    "a duplicated unreported id": () => ({ ...chunk(), unreported_volume_ids: ["pv_01", "pv_01"] }),
    "a duplicated halted id": () => ({
      ...chunk(),
      unreported_volume_ids: ["pv_01"],
      halted_volume_ids: ["pv_01", "pv_01"],
    }),
    "a halted id not listed as unreported": () => ({
      ...chunk(),
      unreported_volume_ids: ["pv_01"],
      halted_volume_ids: ["pv_02"],
    }),
    "a negative chunk index": () => ({ ...chunk(), chunk_index: -1 }),
    "a bad attempt": () => ({ ...chunk(), attempt: "1.x" }),
  };

  it.each(Object.entries(rejected))("refuses %s", (_name, make) => {
    expect(acceptsChunk(make())).toBe(false);
  });

  it("builds the documented idempotency key", () => {
    const body = chunkCompleteBodySchema.parse(chunk());
    expect(chunkIdempotencyKey(body)).toBe(`${body.run_id}:chunk:0:11223344.1`);
  });
});

// @version v0.8.0
