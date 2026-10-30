/**
 * Tests — the capture link's pure parts
 *
 * This suite pins the functions of the capture link that read nothing
 * but their arguments:
 *
 *   - `captureLinkState`, the mapping from a volume's latest delivery,
 *     its pipeline volume and its latest run to the state the status
 *     call answers, one case per state and the order the rules apply in,
 *     with a holding delivery that has a rejected record answered as
 *     `retakes_requested` once nothing else is left to approve;
 *   - scanner tokens: 64 lowercase hex characters, hashed as their
 *     text, read from `Authorization: Bearer` and nothing else;
 *   - `canonicalJson`, which makes two bodies that parse alike digest
 *     alike;
 *   - `parseListing`, the ListObjectsV2 reader: keys with XML entities,
 *     the continuation token, and an answer that is not a listing;
 *   - `mastersListTarget`, which names what is missing and never a value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { captureLinkState, type StatusInput, type StatusRun } from "../../app/lib/capture/status";
import {
  bodyDigest,
  canonicalJson,
  hashScannerToken,
  scanJsonText,
  mintScannerToken,
  parseScannerBearer,
} from "../../app/lib/capture/token";
import { mastersListTarget, MastersListError, parseListing, scanMasters } from "../../app/lib/capture/masters.server";
import {
  CaptureBudgetError,
  capProblems,
  packProblems,
  packRecords,
  RECORDS_BUDGET_BYTES,
  unlistedNotes,
  unpackJson,
} from "../../app/lib/capture/link.server";
import type { CaptureVolume } from "../../app/lib/capture/manifest";
import { fakeS3 } from "../helpers/fake-s3";
import { CAPTURE_FINAL_STATES, CAPTURE_LINK_STATES } from "../../app/lib/validation/enums";

const delivery = (state: "received" | "registered" | "refused" | "superseded", extra = {}) => ({
  id: "m-1",
  state,
  problems: [],
  receivedAt: 100,
  supersededAt: state === "superseded" ? 150 : null,
  openings: 2,
  rejectedRecords: 0,
  ...extra,
});
const volume = (state: string, extra = {}) => ({
  id: "v-1",
  state,
  createdAt: 90,
  updatedAt: 200,
  heldByRunId: null as string | null,
  ...extra,
});
const run = (extra: Partial<StatusRun> = {}): StatusRun => ({
  runId: "r-1",
  holds: true,
  createdAt: 300,
  dispatchedAt: 310,
  completedAt: null,
  volumeStatus: "dispatched",
  volumeReportedAt: null,
  volumeErrorClass: null,
  chunkStatus: "dispatched",
  chunkDispatchedAt: 320,
  ...extra,
});

describe("captureLinkState", () => {
  const CASES: Array<[string, StatusInput, string, number | null]> = [
    ["nothing held", { delivery: null, volume: null, run: null }, "unknown", null],
    ["a refused delivery", { delivery: delivery("refused"), volume: volume("received"), run: null }, "refused", 100],
    ["a superseded delivery", { delivery: delivery("superseded"), volume: volume("received"), run: null }, "superseded", 150],
    ["a delivery still being checked", { delivery: delivery("received"), volume: null, run: null }, "received", 100],
    ["a registered volume with no run", { delivery: delivery("registered"), volume: volume("received"), run: null }, "registered", 100],
    ["a volume registered by the command", { delivery: null, volume: volume("received"), run: null }, "registered", 90],
    [
      "a held volume whose chunk is pending",
      { delivery: delivery("registered"), volume: volume("received", { heldByRunId: "r-1" }), run: run({ chunkStatus: "pending" }) },
      "queued",
      300,
    ],
    [
      "a held volume whose chunk was never sent",
      { delivery: delivery("registered"), volume: volume("received", { heldByRunId: "r-1" }), run: run({ chunkStatus: "not_sent" }) },
      "queued",
      300,
    ],
    [
      "a held volume whose chunk is dispatched",
      { delivery: delivery("registered"), volume: volume("received", { heldByRunId: "r-1" }), run: run() },
      "running",
      320,
    ],
    [
      "a held volume whose chunk failed with its fate unknown",
      { delivery: delivery("registered"), volume: volume("received", { heldByRunId: "r-1" }), run: run({ chunkStatus: "failed" }) },
      "running",
      320,
    ],
    [
      "an aborted job",
      {
        delivery: delivery("registered"),
        volume: volume("received"),
        run: run({ holds: false, volumeStatus: "aborted", volumeReportedAt: 400, volumeErrorClass: "fixity" }),
      },
      "failed",
      400,
    ],
    [
      "a run that closed without the volume reporting",
      { delivery: delivery("registered"), volume: volume("received"), run: run({ holds: false, completedAt: 500 }) },
      "failed",
      500,
    ],
    ["a prepared volume", { delivery: delivery("registered"), volume: volume("prepared"), run: run({ volumeStatus: "review_pending", volumeReportedAt: 410 }) }, "review_pending", 410],
    ["a ready volume", { delivery: delivery("registered"), volume: volume("ready"), run: null }, "review_pending", 200],
    ["a published volume", { delivery: delivery("registered"), volume: volume("published"), run: run() }, "published", 200],
  ];

  it.each(CASES)("maps %s", (_name, input, state, enteredAt) => {
    const out = captureLinkState(input);
    expect(out.state).toBe(state);
    expect(out.enteredAt).toBe(enteredAt);
  });

  it("carries the delivery's problems in every state, and the pipeline's error when it failed", () => {
    const notes = [{ rule: "unlisted-object", message: "x" }];
    const published = captureLinkState({ delivery: delivery("registered", { problems: notes }), volume: volume("published"), run: null });
    expect(published.problems).toEqual(notes);
    const failed = captureLinkState({
      delivery: delivery("registered", { problems: notes }),
      volume: volume("received"),
      run: run({ holds: false, volumeStatus: "halted", volumeErrorClass: "source_pull" }),
    });
    expect(failed.problems).toEqual([...notes, expect.objectContaining({ rule: "pipeline", errorClass: "source_pull" })]);
  });

  it("answers a capture QC state when one is given, before processing (the QC hook)", () => {
    for (const state of ["preparing_review", "in_capture_qc", "retakes_requested", "approved"] as const) {
      const out = captureLinkState({
        delivery: delivery("registered"),
        volume: volume("received"),
        run: null,
        captureQc: { state, enteredAt: 250 },
      });
      expect(out).toMatchObject({ state, enteredAt: 250 });
    }
    // Processing outranks it once a run has named the volume.
    expect(
      captureLinkState({
        delivery: delivery("registered"),
        volume: volume("received", { heldByRunId: "r-1" }),
        run: run(),
        captureQc: { state: "approved", enteredAt: 250 },
      }).state,
    ).toBe("running");
  });

  it("answers retakes_requested for a delivery with a rejected record and nothing else to approve", () => {
    const held = delivery("registered", { rejectedRecords: 1 });
    const base = { volume: volume("received"), run: null };
    // Every opening approved: the unit owes the retake, so not approved.
    expect(captureLinkState({ ...base, delivery: held, captureQc: { state: "approved", enteredAt: 250 } })).toMatchObject({
      state: "retakes_requested",
      enteredAt: 250,
    });
    // No openings at all: retakes requested from when it was received.
    expect(captureLinkState({ ...base, delivery: delivery("registered", { openings: 0, rejectedRecords: 2 }) })).toMatchObject({
      state: "retakes_requested",
      enteredAt: 100,
    });
    // Openings still to decide or rejected: the decision set's state stands.
    for (const state of ["in_capture_qc", "retakes_requested"] as const) {
      expect(captureLinkState({ ...base, delivery: held, captureQc: { state, enteredAt: 250 } }).state).toBe(state);
    }
    expect(captureLinkState({ ...base, delivery: held }).state).toBe("registered");
    expect(captureLinkState({ ...base, delivery: held, review: { state: "ready", enteredAt: 240 } }).state).toBe("in_capture_qc");
    // An open review run, and processing, come first.
    expect(
      captureLinkState({
        ...base,
        delivery: held,
        captureQc: { state: "approved", enteredAt: 250 },
        review: { state: "open", enteredAt: 260 },
      }).state,
    ).toBe("preparing_review");
    expect(
      captureLinkState({
        delivery: held,
        volume: volume("received", { heldByRunId: "r-1" }),
        run: run(),
        captureQc: { state: "approved", enteredAt: 250 },
      }).state,
    ).toBe("running");
    // Without a rejected record an approved set is approved.
    expect(captureLinkState({ ...base, delivery: delivery("registered"), captureQc: { state: "approved", enteredAt: 250 } }).state).toBe(
      "approved",
    );
  });

  it("has the contract's whole vocabulary", () => {
    expect([...CAPTURE_LINK_STATES]).toEqual([
      "received", "registered", "preparing_review", "in_capture_qc", "retakes_requested", "approved",
      "queued", "running", "review_pending", "published", "refused", "superseded", "failed", "unknown",
    ]);
    expect([...CAPTURE_FINAL_STATES]).toEqual(["published", "refused", "superseded"]);
  });

  it("reads a refused delivery as refused whatever the volume is doing", () => {
    expect(captureLinkState({ delivery: delivery("refused"), volume: volume("published"), run: null }).state).toBe("refused");
  });
});

describe("scanner tokens", () => {
  it("are 64 lowercase hex characters, hashed as their text", async () => {
    const { token, sha256 } = await mintScannerToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256).toBe(await hashScannerToken(token));
    expect(sha256).not.toBe(token);
    expect((await mintScannerToken()).token).not.toBe(token);
  });

  it("are read from a Bearer header and nothing else", () => {
    const t = "ab".repeat(32);
    expect(parseScannerBearer(`Bearer ${t}`)).toBe(t);
    expect(parseScannerBearer(`bearer ${t}`)).toBe(t);
    expect(parseScannerBearer(null)).toBeNull();
    expect(parseScannerBearer(t)).toBeNull();
    expect(parseScannerBearer(`Bearer  ${t}`)).toBeNull();
    expect(parseScannerBearer(`Bearer ${t.toUpperCase()}`)).toBeNull();
    expect(parseScannerBearer(`Bearer ${t}0`)).toBeNull();
    expect(parseScannerBearer(`Basic ${t}`)).toBeNull();
  });
});

describe("canonicalJson", () => {
  it("writes parsed JSON with sorted keys and no whitespace", async () => {
    const a = JSON.parse('{"b": [1, {"y": 2, "x": 1.0}], "a": null}');
    const b = JSON.parse('{"a":null,"b":[1,{"x":1,"y":2}]}');
    expect(canonicalJson(a)).toBe('{"a":null,"b":[1,{"x":1,"y":2}]}');
    expect(await bodyDigest(a)).toBe(await bodyDigest(b));
    expect(await bodyDigest({ a: [1, 2] })).not.toBe(await bodyDigest({ a: [2, 1] }));
  });
});

describe("scanJsonText", () => {
  const inRoot = (n: number, inner: string) => `{"a":${"[".repeat(n)}${inner}${"]".repeat(n)}}`;

  it("counts depth in containers, the same way canonicalJson does, at the exact boundary", () => {
    // The root object and 63 arrays make 64 levels; the scalar adds none.
    const at = inRoot(63, "1");
    expect(scanJsonText(at)).toEqual({ ok: true });
    expect(canonicalJson(JSON.parse(at))).toBe(at);
    expect(scanJsonText(inRoot(63, ""))).toEqual({ ok: true });
    // One array more is 65 levels: refused by both.
    const past = inRoot(64, "1");
    expect(scanJsonText(past)).toMatchObject({ ok: false, message: expect.stringMatching(/deeper than 64/) });
    expect(() => canonicalJson(JSON.parse(past))).toThrow(/deeper than 64/);
    expect(scanJsonText("[".repeat(10_000) + "]".repeat(10_000)).ok).toBe(false);
  });

  it("refuses more containers or values than a 5 MiB manifest could hold, before parsing", () => {
    const objects = `{"id":"x","unknown":[${Array(1_500_000).fill("{}").join(",")}]}`;
    expect(objects.length).toBeGreaterThan(4_000_000);
    expect(scanJsonText(objects)).toMatchObject({ ok: false, message: expect.stringMatching(/objects and arrays/) });
    const zeros = `[${Array(1_600_000).fill("0").join(",")}]`;
    expect(scanJsonText(zeros)).toMatchObject({ ok: false, message: expect.stringMatching(/values/) });
  });

  it("passes the densest legitimate manifest at 5 MiB, and ignores brackets inside strings", () => {
    const record = (i: number) =>
      `{"captuaRecordId":${i},"sequence":${i},"status":"captured","rejectionNote":null,"images":[]}`;
    const parts: string[] = [];
    let size = 0;
    for (let i = 0; size < 5 * 1024 * 1024 - 200; i++) {
      const r = record(i);
      parts.push(r);
      size += r.length + 1;
    }
    expect(scanJsonText(`{"volumes":[{"records":[${parts.join(",")}]}]}`)).toEqual({ ok: true });
    expect(scanJsonText(`{"a":"${"[".repeat(100)}\\"${"{".repeat(100)}"}`)).toEqual({ ok: true });
  });
});

describe("parseListing", () => {
  it("reads keys, sizes and the continuation token, decoding entities", () => {
    const xml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>' +
      "<Contents><Key>s/a&amp;b&#39;c.jpg</Key><Size>12</Size></Contents>" +
      "<Contents><Key>s/d.jpg</Key><Size>0</Size></Contents>" +
      "<NextContinuationToken>tok&lt;1&gt;</NextContinuationToken></ListBucketResult>";
    expect(parseListing(xml)).toEqual({ objects: [["s/a&b'c.jpg", 12], ["s/d.jpg", 0]], next: "tok<1>" });
  });

  it("ends without a token when not truncated, and refuses what is not a listing", () => {
    expect(parseListing("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")).toEqual({
      objects: [],
      next: null,
    });
    expect(() => parseListing("<Error><Code>AccessDenied</Code></Error>")).toThrow(MastersListError);
    expect(() => parseListing("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>")).toThrow(
      /continuation token/,
    );
  });
});

describe("mastersListTarget", () => {
  const federation = {
    pipelineDeliveryEndpoint: "https://s3.us-west-000.backblazeb2.com/",
    pipelineMastersBucket: "acme-masters",
    storageSecretPrefix: "FEDERATION_ACME",
  };
  const secrets = {
    FEDERATION_ACME_MASTERS_LIST_KEY_ID: "id",
    FEDERATION_ACME_MASTERS_LIST_SECRET_KEY: "secret",
  };

  it("gives the endpoint, region, bucket and key", () => {
    expect(mastersListTarget(federation, secrets)).toEqual({
      endpoint: "https://s3.us-west-000.backblazeb2.com",
      region: "us-west-000",
      bucket: "acme-masters",
      keyId: "id",
      secretKey: "secret",
    });
  });

  it("names what is missing and never a value", () => {
    const missing = (f: typeof federation | null, env: object) => {
      try {
        mastersListTarget(f, env);
      } catch (err) {
        expect(err).toBeInstanceOf(MastersListError);
        expect((err as Error).message).not.toContain("secret");
        return (err as MastersListError).missing;
      }
      throw new Error("expected a refusal");
    };
    expect(missing(null, secrets)).toEqual(["federation"]);
    expect(missing(federation, {})).toEqual(["secret:MASTERS_LIST_KEY_ID", "secret:MASTERS_LIST_SECRET_KEY"]);
    expect(missing({ ...federation, storageSecretPrefix: "bad prefix" }, secrets)).toEqual(["storage_secret_prefix"]);
    expect(missing({ ...federation, pipelineDeliveryEndpoint: "https://example.test" }, secrets)).toEqual([
      "pipeline_delivery_endpoint",
    ]);
  });
});

describe("the budgets", () => {
  const problem = (i: number) => ({ rule: "object-missing", message: `object ${i} is missing`, objectKey: `k/${i}` });

  it("packProblems never returns more than its budget, and throws when not even the truncation entry fits", async () => {
    const list = Array.from({ length: 5000 }, (_, i) => problem(i));
    for (const budget of [200, 5_000]) {
      const packed = await packProblems(list, budget, (l) => JSON.stringify(l));
      expect(new TextEncoder().encode(packed).length).toBeLessThanOrEqual(budget);
      const back = JSON.parse(await unpackJson(packed));
      const last = back[back.length - 1];
      expect(last.rule).toBe("problems-truncated");
      expect(back.length - 1 + last.omitted).toBe(5000);
    }
    await expect(packProblems(list, 10, (l) => JSON.stringify(l))).rejects.toBeInstanceOf(CaptureBudgetError);
  });

  it("packProblems keeps the count of a list that was already cut", async () => {
    const list = [...Array.from({ length: 3000 }, (_, i) => problem(i)), { rule: "problems-truncated", message: "x", omitted: 7000 }];
    const back = JSON.parse(await unpackJson(await packProblems(list, 5_000, (l) => JSON.stringify(l))));
    expect(back.length - 1 + back[back.length - 1].omitted).toBe(10_000);
  });

  it("capProblems keeps the first problems and counts every other", () => {
    const list = [...Array.from({ length: 300 }, (_, i) => problem(i)), { rule: "problems-truncated", message: "x", omitted: 50 }];
    const capped = capProblems(list, 100);
    expect(capped).toHaveLength(101);
    expect(capped[100]).toMatchObject({ rule: "problems-truncated", omitted: 250 });
    expect(capProblems([problem(1)], 100)).toEqual([problem(1)]);
  });

  const volumeOf = (records: CaptureVolume["records"]): CaptureVolume =>
    ({ externalId: "co-x", captuaCollectionId: 1, stem: "co-x", title: "", records }) as CaptureVolume;
  const random = () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

  it("packRecords fits the most openings a 5 MiB manifest can name, with arbitrary ids", async () => {
    // As many records as fit a 5 MiB manifest, each id and sequence a
    // random 53-bit integer, the least compressible a manifest can send.
    const records: CaptureVolume["records"] = [];
    let size = 200;
    for (;;) {
      const r = {
        captuaRecordId: random(),
        sequence: random(),
        status: (["captured", "in_review", "approved", "rejected"] as const)[random() % 4],
        rejectionNote: null,
        images: [],
      };
      size += JSON.stringify(r).length + 1;
      if (size > 5 * 1024 * 1024) break;
      records.push(r);
    }
    expect(records.length).toBeGreaterThan(40_000);
    const packed = await packRecords(volumeOf(records));
    expect(new TextEncoder().encode(packed).length).toBeLessThanOrEqual(RECORDS_BUDGET_BYTES);
  });

  it("packRecords shortens rejection notes before it gives up, and throws rather than overrun", async () => {
    const noise = () => Array.from(crypto.getRandomValues(new Uint8Array(1000)), (b) => b.toString(16).padStart(2, "0")).join("");
    const records = Array.from({ length: 2400 }, (_, i) => ({
      captuaRecordId: i,
      sequence: i,
      status: "rejected" as const,
      rejectionNote: noise(),
      images: [],
    }));
    const packed = await packRecords(volumeOf(records));
    expect(new TextEncoder().encode(packed).length).toBeLessThanOrEqual(RECORDS_BUDGET_BYTES);
    const back = JSON.parse(await unpackJson(packed));
    expect(back[0].rejectionNote.length).toBeLessThan(2000);
    await expect(packRecords(volumeOf(records), 50)).rejects.toBeInstanceOf(CaptureBudgetError);
  });
});

describe("scanMasters", () => {
  it("keeps 1,000 stray objects by name and counts the rest, a page at a time", async () => {
    const s3 = fakeS3(["masters"]);
    const named = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const key = `t/v/captures/v-img_${String(i).padStart(4, "0")}_c0.jpg`;
      named.add(key);
      s3.objects.set(`masters/${key}`, { bytes: new Uint8Array(7), etag: "e", contentType: null, meta: {} });
    }
    for (let i = 0; i < 100_000; i++) {
      s3.objects.set(`masters/t/v/stray/${String(i).padStart(6, "0")}`, { bytes: new Uint8Array(1), etag: "e", contentType: null, meta: {} });
    }
    const target = { endpoint: "https://s3.us-west-000.backblazeb2.com", region: "us-west-000", bucket: "masters", keyId: "k", secretKey: "s" };
    const scan = await scanMasters(target, "t/v/", named, s3.fetch);
    expect(scan.present.size).toBe(10);
    expect([...scan.present.values()].every((n) => n === 7)).toBe(true);
    expect(scan.unlisted).toHaveLength(1000);
    expect(scan.unlistedOmitted).toBe(99_000);
    expect(scan.pages).toBe(101);
    const notes = unlistedNotes("v", scan);
    expect(notes).toHaveLength(1001);
    expect(notes[1000]).toMatchObject({ rule: "problems-truncated", omitted: 99_000 });
    expect(new TextEncoder().encode(JSON.stringify(notes)).length).toBeLessThan(200_000);
  });
});

// @version v0.8.0
