/**
 * Tests — the federation storage command
 *
 * This suite pins the federation step: the command that sets up a
 * federation's pipeline storage and records it on the federation's row,
 * run against in-memory providers (`tests/import/tenant-storage-fakes.ts`).
 * Nothing here reaches an account.
 *
 *   - names: buckets (tiles, masters, manifests), hosts, secret prefix
 *     `FEDERATION_{SLUG}` and Fisqua's key names from the federation's
 *     slug, the domain and the target; staging adds `-staging` to the
 *     buckets and keys and to the host labels; a slug or domain of the
 *     wrong form is refused;
 *   - the dry run reads and writes nothing, prints each step, and
 *     returns the record it would write;
 *   - an applied run creates the tiles, masters and manifest buckets (the
 *     masters bucket private with no CORS rule and no host), the hosts,
 *     the Transform Rule (keeping the zone's other rules), Fisqua's three
 *     keys (the masters list key with `listBuckets` and `listFiles` only),
 *     the six Worker secrets and the federation record, and no
 *     runner Environment or runner key; a second run finds everything and
 *     changes nothing;
 *   - a run that fails part way is finished by the next one without
 *     issuing a key whose secrets are already set;
 *   - a taken B2 bucket name, a public bucket where the masters bucket
 *     should be, a zone not in the account, a tiles host already pointing
 *     elsewhere, pending work in any tenant of the federation, and
 *     another federation naming the same bucket each stop the command,
 *     pending work and a value another federation has in any unique
 *     column before anything is created, issued or set;
 *   - provisioning with an existing masters bucket (`--masters-bucket`)
 *     creates no masters bucket and leaves the one given unchanged, prints
 *     it as `[exists] … (adopted)`, issues Fisqua's list key limited to it
 *     and records it, on staging under the same name as in production; a
 *     bucket missing from the account or not private stops the command
 *     before anything is created, and so does one another federation
 *     records; a different masters bucket recorded on the federation has
 *     its list key issued again; without the flag nothing changes;
 *   - adoption (Neogranadina's federation only) creates no bucket or
 *     host, needs the masters bucket in the account and private, issues
 *     Fisqua's three keys limited to the existing buckets, each only
 *     where its secrets are not set, sets the six Worker secrets and writes the record; a value another federation
 *     has in any unique column, the secret prefix included, stops it
 *     before a key is issued or a secret set; adopting again with another
 *     tiles, manifest or masters bucket issues the key limited to it again
 *     (`[reissue]`, the replaced key left for deletion by hand) and names
 *     the tenants whose runner keys must follow; on the local target only
 *     the record is written;
 *   - no issued key or secret value appears in the output;
 *   - the arguments: production needs `--confirm-production` to apply,
 *     provisioning needs a domain and takes no storage flag but
 *     `--masters-bucket`, adoption needs every address and the masters
 *     bucket as flags;
 *   - the D1 statements: one UPDATE of the eight columns scoped to the
 *     federation, and pending work counted across the federation's
 *     tenants;
 *   - the review-tiles bucket: created private (`{slug}-review-tiles`,
 *     `{slug}-staging-review-tiles` on staging) with no lifecycle rule
 *     and one CORS rule allowing downloads, with the `authorization` and
 *     `range` headers only, from the target's tenant hosts only, never
 *     `*` and never the apex, which covers every tenant host
 *     `wrangler.jsonc` routes and excludes the routed apex; an existing private bucket of its name is adopted and its CORS
 *     rules set when they differ, compared in order; a public one, a taken
 *     name or another federation recording it stops the command; Fisqua's
 *     share key on it (list, read, share) is issued once and held in two
 *     Worker secrets, and issued again when the record names another
 *     review-tiles bucket; a federation provisioned or adopted before
 *     the bucket existed gains the bucket, the key, the two secrets and
 *     the column, even with pending work, and nothing else changes, while
 *     a change to a recorded column is still refused; on the local target
 *     adoption neither makes nor records it;
 *   - a record without the review-tiles bucket is complete, and an UPDATE
 *     without the column leaves it as recorded;
 *   - one bucket name serving two roles stops provisioning and adoption
 *     before anything is touched: two of the federation's buckets, one
 *     and the shared working bucket, or one and another federation's
 *     bucket of another role;
 *   - a planned bucket that the federation's own record holds in another
 *     role (a bucket the run would replace included) stops provisioning
 *     and adoption before anything is touched, as when a recorded masters
 *     bucket would become the review-tiles bucket; the same buckets in
 *     the same roles go ahead;
 *   - bucket role tags in B2 (`fisqua-role`, `fisqua-env`,
 *     `fisqua-federation`), which staging and production both see: a
 *     staging review-tiles bucket given to production as masters stops it
 *     with nothing created; a bucket tagged for another environment, role
 *     or federation is refused in the dry run; a masters bucket is tagged
 *     with its role and federation only, so a staging run and then a
 *     production run share one with no `fisqua-env` written, and one
 *     already tagged for production is accepted by staging unchanged,
 *     while one tagged for another federation or role is still refused,
 *     as is a tiles bucket tagged for the other environment; an untagged
 *     masters bucket is tagged on a rerun with its other bucket info kept; setting CORS
 *     rules keeps the tags; a review-tiles bucket with files is adopted
 *     when it carries this federation's tag;
 *   - tag writes go at the revision read: when another run tags the
 *     bucket in between, B2 refuses the write and the second writer fails
 *     on the tag the first set, with no key over the bucket for another
 *     role; a harmless change in between is read and checked again; a tag
 *     that changes after the checks stops the run before any key is
 *     issued;
 *   - a masters bucket the record moves away from is tagged as masters
 *     first, so a later tenant run cannot take it as its working bucket;
 *     one no longer in the account is reported and skipped, one tagged
 *     for another role stops the run, and one tagged for the other
 *     environment moves out of the record with its tag unchanged;
 *   - every bucket the record moves away from (tiles, masters, review
 *     tiles) keeps the tag of its role: a replaced tiles bucket bearing
 *     the staging working bucket's name cannot become staging's working
 *     bucket, and gets no working key;
 *   - the working bucket command adopts only an empty bucket or one
 *     tagged as working, and refuses an untagged one holding files;
 *   - the provisioning lock: a second applied run, federation or tenant,
 *     refuses while the first holds it, naming the holder and start; a
 *     dry run takes none; an expired one is taken over; it is released
 *     when a run ends or stops;
 *   - a held Fisqua key whose live key is missing, limited elsewhere or
 *     with other capabilities (or an R2 token missing by name) is issued
 *     again;
 *   - a pair's write is marked in D1 from before its key is issued until
 *     both secrets are written: a failed second secret deletes the new key
 *     (or reports it left when that fails too) and leaves the mark, and
 *     the next run issues the marked pair again from scratch even with a
 *     correctly scoped live key; a crashed run's marks are handled the
 *     same, for the tiles, masters and share pairs; a full run leaves no
 *     mark; every reissue shows its secrets as to be replaced;
 *   - the lock's fencing token: a write that lands after the lock was
 *     lost marks its pair again instead of clearing it, and the next run
 *     repairs the pair; a run that loses its lock before a write stops
 *     without writing; renewal at each write keeps a slow run's lock; an
 *     incomplete pair's existing secret is reported as to be replaced;
 *   - marks are owned: a stale writer's re-mark carries its token, so
 *     the run that took over cannot clear it, stops naming the pair, and
 *     the next run reissues it matching; an ordinary run clears its own
 *     mark;
 *   - a secret write that throws is taken as possibly applied: after a
 *     lost lock, or with the lock still held, the pair is marked with the
 *     run's token and the next run repairs it; every stop message states
 *     the mark as read back from D1, a failed key issue included;
 *   - fenced D1 writes: a stale run's destination write after another
 *     run took the expired lock is refused and the other run's record
 *     stands; a stale snapshot is refused with the lock held; a pair is
 *     not marked once the lock is lost;
 *   - the pending-work exemption holds only when every record column,
 *     both account endpoints included, matches what the run would write:
 *     credentials for another Cloudflare or B2 account are refused before
 *     any key or secret, with the marks left as they are; matching
 *     endpoints still pass;
 *   - the recorded masters bucket changes only with `--masters-bucket`:
 *     without it the recorded one is kept and a rerun creates nothing;
 *     the flag naming the recorded bucket is a no-op; the flag naming
 *     another replaces it under the existing rules (refused while work is
 *     pending, list key issued again, old key left for deletion by hand,
 *     tenants named);
 *   - an existing review-tiles bucket that holds any file version, hidden
 *     or old ones included, stops provisioning and adoption unless the
 *     record already names it as the review-tiles bucket: a masters
 *     bucket another federation moved away from cannot become a review
 *     bucket, and nothing is issued over it; an empty one is adopted, and
 *     a rerun over the recorded bucket with tiles in it goes ahead;
 *   - an existing review-tiles bucket with lifecycle rules stops
 *     provisioning and adoption, dry run included, naming the rules and
 *     leaving them in place; an empty list is adopted.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  checkDestinationValues,
  destinationStatement,
  isRecordComplete,
  missingRecordColumns,
  pendingWorkStatement,
  ProvisionStop,
  B2_CORS_RULES,
  R2_CORS_RULES,
  type DestinationValues,
} from "../../scripts/lib/tenant-storage";
import {
  adoptFederationStorage,
  federationStorageNames,
  provisionFederationStorage,
  reviewTilesCorsRules,
  reviewTilesOrigins,
} from "../../scripts/lib/federation-storage";
import { adoptValuesFrom, parseArgs, runFederationCommand } from "../../scripts/commands/provision-federation-storage";
import { provisionTenantStorage } from "../../scripts/lib/tenant-storage";
import { provisionWorkingBucket } from "../../scripts/lib/working-bucket";
import {
  emptyFederation,
  fakeWorld,
  FAKE_B2_DOWNLOAD,
  FAKE_B2_S3,
  FAKE_FEDERATION_ID,
  FAKE_R2_S3,
  FAKE_WORKING_BUCKET,
} from "./tenant-storage-fakes";

const OPTS = { slug: "acme", domain: "acme.example.test", target: "production" as const };
const SHARED_MASTERS = "shared-masters";
const STAGING = { ...OPTS, target: "staging" as const };
const WRITES = /create|put|set|update|add|write/i;

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

const writeCalls = (calls: string[]) => calls.filter((c) => WRITES.test(c.split(".")[1] ?? ""));

describe("federation storage names", () => {
  it("derives every production name from the federation's slug and the domain", () => {
    expect(federationStorageNames("acme-group", "acme.example.test", "production")).toEqual({
      tilesBucket: "acme-group-iiif-tiles",
      mastersBucket: "acme-group-masters",
      reviewTilesBucket: "acme-group-review-tiles",
      manifestBucket: "acme-group-manifests",
      tilesHost: "iiif.acme.example.test",
      manifestHost: "manifests.acme.example.test",
      imageBaseUrl: "https://iiif.acme.example.test",
      manifestBaseUrl: "https://manifests.acme.example.test",
      secretPrefix: "FEDERATION_ACME_GROUP",
      keys: {
        fisquaRead: "fisqua-acme-group-tiles-fisqua-read",
        manifestWrite: "fisqua-acme-group-manifests-write",
        mastersList: "fisqua-acme-group-masters-list",
        reviewShare: "fisqua-acme-group-review-tiles-fisqua-share",
      },
    });
  });

  it("adds -staging to the buckets, the keys and the host labels on staging", () => {
    const names = federationStorageNames("acme", "acme.example.test", "staging");
    expect(names).toMatchObject({
      tilesBucket: "acme-staging-iiif-tiles",
      mastersBucket: "acme-staging-masters",
      reviewTilesBucket: "acme-staging-review-tiles",
      manifestBucket: "acme-staging-manifests",
      tilesHost: "iiif-staging.acme.example.test",
      manifestHost: "manifests-staging.acme.example.test",
      secretPrefix: "FEDERATION_ACME",
    });
    expect(Object.values(names.keys).every((k) => k.startsWith("fisqua-acme-staging-"))).toBe(true);
  });

  it("refuses a slug or a domain of the wrong form", () => {
    expect(() => federationStorageNames("Acme", "acme.example.test", "production")).toThrow();
    expect(() => federationStorageNames("acme", "https://acme.example.test", "production")).toThrow();
    expect(() => federationStorageNames("acme", "acme", "production")).toThrow();
  });
});

describe("provisioning a federation", () => {
  it("dry run: reads, writes nothing, and returns the record it would write", async () => {
    const { world, providers } = fakeWorld();
    const out = capture();
    const values = await provisionFederationStorage({ ...OPTS, apply: false }, providers, out.log);
    expect(values).toEqual({
      pipeline_delivery_endpoint: FAKE_B2_S3,
      pipeline_tiles_bucket: "acme-iiif-tiles",
      pipeline_masters_bucket: "acme-masters",
      pipeline_image_base_url: "https://iiif.acme.example.test",
      manifest_endpoint: FAKE_R2_S3,
      manifest_bucket: "acme-manifests",
      manifest_base_url: "https://manifests.acme.example.test",
      storage_secret_prefix: "FEDERATION_ACME",
      pipeline_review_tiles_bucket: "acme-review-tiles",
    });
    expect(writeCalls(world.calls)).toEqual([]);
    expect(world.d1.writes).toBe(0);
    expect(out.text()).toContain("would create B2 bucket acme-iiif-tiles");
    expect(out.text()).toContain(
      "would create B2 bucket acme-review-tiles, private, no lifecycle rule, " +
        "CORS GET/HEAD from https://*.fisqua.org",
    );
    expect(out.text()).toContain(
      "would issue fisqua-acme-review-tiles-fisqua-share: B2 key, list, read and share, limited to acme-review-tiles (Fisqua)",
    );
    expect(out.text()).toContain("[would set] FEDERATION_ACME_REVIEW_SHARE_KEY_ID");
    expect(out.text()).toContain("[would set] FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY");
    expect(out.text()).toContain("pipeline_review_tiles_bucket: (empty) -> acme-review-tiles");
    expect(out.text()).toContain("would create B2 bucket acme-masters, private, no CORS rule, no host");
    expect(out.text()).toContain("would issue fisqua-acme-tiles-fisqua-read");
    expect(out.text()).toContain("would issue fisqua-acme-manifests-write");
    expect(out.text()).toContain("[would set] FEDERATION_ACME_DELIVERY_READ_KEY_ID");
    expect(out.text()).toContain("would issue fisqua-acme-masters-list: B2 key, list only, limited to acme-masters (Fisqua)");
    expect(out.text()).toContain("[would set] FEDERATION_ACME_MASTERS_LIST_KEY_ID");
    expect(out.text()).toContain("[would set] FEDERATION_ACME_MASTERS_LIST_SECRET_KEY");
    expect(out.text()).toContain("would write 9 column(s) to the federation record");
    expect(out.text()).not.toContain("runner");
  });

  it("apply: creates everything once, and a second run changes nothing", async () => {
    const { world, providers } = fakeWorld();
    const out = capture();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, out.log);

    const tiles = world.b2.buckets.get("acme-iiif-tiles")!;
    expect(tiles).toMatchObject({ bucketType: "allPublic", corsRules: B2_CORS_RULES });
    expect(world.b2.buckets.get("acme-masters")).toMatchObject({ bucketType: "allPrivate", corsRules: [] });
    expect(world.cf.r2.has("acme-manifests")).toBe(true);
    expect(world.cf.cors.get("acme-manifests")).toEqual(R2_CORS_RULES);
    expect(world.cf.domains.get("acme-manifests")).toEqual(["manifests.acme.example.test"]);
    // The masters bucket has no host.
    expect([...world.cf.cnames.keys()]).toEqual(["iiif.acme.example.test"]);
    expect(world.cf.cnames.get("iiif.acme.example.test")).toEqual({
      content: new URL(FAKE_B2_DOWNLOAD).hostname,
      proxied: true,
    });
    const rules = world.cf.rules.get("zone-acme")!;
    expect(rules.map((r) => r.id ?? r.expression)).toEqual(["keep-me", "(http.host eq \"iiif.acme.example.test\")"]);
    expect(rules[1].action_parameters).toEqual({
      uri: { path: { expression: "concat(\"/file/acme-iiif-tiles\", http.request.uri.path)" } },
    });

    // Fisqua's read key covers the whole tiles bucket and its list key the
    // whole masters bucket; the runner's keys are the tenant step's.
    expect(world.b2.keys.map((k) => [k.name, k.bucketId, k.capabilities.includes("writeFiles"), k.namePrefix ?? null])).toEqual([
      ["fisqua-acme-tiles-fisqua-read", tiles.bucketId, false, null],
      ["fisqua-acme-masters-list", world.b2.buckets.get("acme-masters")!.bucketId, false, null],
      ["fisqua-acme-review-tiles-fisqua-share", world.b2.buckets.get("acme-review-tiles")!.bucketId, false, null],
    ]);
    expect(world.b2.keys[1].capabilities).toEqual(["listBuckets", "listFiles"]);
    expect(world.cf.tokens).toEqual([{ name: "fisqua-acme-manifests-write", bucket: "acme-manifests" }]);
    expect(world.gh.environments.size).toBe(0);
    expect(world.calls.filter((c) => c.startsWith("gh."))).toEqual([]);
    expect([...world.worker.keys()].sort()).toEqual([
      "FEDERATION_ACME_DELIVERY_READ_KEY_ID",
      "FEDERATION_ACME_DELIVERY_READ_SECRET_KEY",
      "FEDERATION_ACME_MANIFEST_WRITE_KEY_ID",
      "FEDERATION_ACME_MANIFEST_WRITE_SECRET_KEY",
      "FEDERATION_ACME_MASTERS_LIST_KEY_ID",
      "FEDERATION_ACME_MASTERS_LIST_SECRET_KEY",
      "FEDERATION_ACME_REVIEW_SHARE_KEY_ID",
      "FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY",
    ]);
    expect(world.d1.federations[0]).toMatchObject({
      pipeline_tiles_bucket: "acme-iiif-tiles",
      pipeline_masters_bucket: "acme-masters",
      pipeline_review_tiles_bucket: "acme-review-tiles",
      manifest_bucket: "acme-manifests",
      manifest_base_url: "https://manifests.acme.example.test",
      storage_secret_prefix: "FEDERATION_ACME",
    });
    expect(world.d1.pendingScopes).toContainEqual({ federationId: FAKE_FEDERATION_ID });

    for (const value of world.issued) expect(out.text()).not.toContain(value);

    const callsBefore = world.calls.length;
    const again = capture();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, again.log);
    expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    expect(world.d1.writes).toBe(1);
    expect(again.text()).not.toContain("[create]");
    expect(again.text()).toContain("already holds this destination");
  });

  it("staging: every bucket, host and key carries the staging name", async () => {
    const { world, providers } = fakeWorld();
    const values = await provisionFederationStorage({ ...STAGING, apply: true }, providers, () => {});
    expect([...world.b2.buckets.keys()]).toContain("acme-staging-iiif-tiles");
    expect([...world.b2.buckets.keys()]).toContain("acme-staging-masters");
    expect([...world.cf.r2]).toEqual(["acme-staging-manifests"]);
    expect(world.cf.domains.get("acme-staging-manifests")).toEqual(["manifests-staging.acme.example.test"]);
    expect([...world.cf.cnames.keys()]).toEqual(["iiif-staging.acme.example.test"]);
    expect([...world.b2.buckets.keys()]).toContain("acme-staging-review-tiles");
    expect(world.b2.buckets.get("acme-staging-review-tiles")!.corsRules).toEqual(reviewTilesCorsRules("staging"));
    expect(world.b2.keys.map((k) => k.name)).toEqual([
      "fisqua-acme-staging-tiles-fisqua-read",
      "fisqua-acme-staging-masters-list",
      "fisqua-acme-staging-review-tiles-fisqua-share",
    ]);
    expect(world.cf.tokens).toEqual([{ name: "fisqua-acme-staging-manifests-write", bucket: "acme-staging-manifests" }]);
    expect(values).toMatchObject({
      pipeline_tiles_bucket: "acme-staging-iiif-tiles",
      pipeline_masters_bucket: "acme-staging-masters",
      pipeline_image_base_url: "https://iiif-staging.acme.example.test",
      manifest_base_url: "https://manifests-staging.acme.example.test",
      storage_secret_prefix: "FEDERATION_ACME",
      pipeline_review_tiles_bucket: "acme-staging-review-tiles",
    });
  });

  it("finishes a run that failed part way without issuing a held key again", async () => {
    let fail = true;
    const { world, providers } = fakeWorld({
      failOn: (c) => fail && c === "worker.put:FEDERATION_ACME_DELIVERY_READ_KEY_ID",
    });
    await expect(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {})).rejects.toThrow(/fake failure/);
    expect(world.d1.writes).toBe(0);
    fail = false;
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    const issued = world.calls.filter((c) => c.startsWith("b2.createKey:") || c.startsWith("cf.createR2WriteToken:"));
    expect(issued).toEqual([
      "b2.createKey:fisqua-acme-tiles-fisqua-read",
      // The read key's secrets were not both set, so it is issued again.
      "b2.createKey:fisqua-acme-tiles-fisqua-read",
      "cf.createR2WriteToken:fisqua-acme-manifests-write",
      "b2.createKey:fisqua-acme-masters-list",
      "b2.createKey:fisqua-acme-review-tiles-fisqua-share",
    ]);
    expect(world.calls.filter((c) => c.startsWith("b2.createBucket:"))).toEqual([
      "b2.createBucket:acme-iiif-tiles",
      "b2.createBucket:acme-masters",
      "b2.createBucket:acme-review-tiles",
    ]);
    expect(world.d1.writes).toBe(1);
  });

  it("stops at a taken bucket name, a public masters bucket, a missing zone or a tiles host pointing elsewhere", async () => {
    const a = fakeWorld();
    a.world.b2.taken.add("acme-iiif-tiles");
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, a.providers, () => {}))).toMatch(
      /acme-iiif-tiles is taken/,
    );
    expect(a.world.cf.r2.size).toBe(0);
    expect(a.world.b2.keys).toEqual([]);

    const b = fakeWorld();
    b.world.b2.buckets.set("acme-masters", { bucketId: "b-m", bucketName: "acme-masters", bucketType: "allPublic", corsRules: [] });
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: false }, b.providers, () => {}))).toMatch(
      /acme-masters exists but is allPublic, not allPrivate/,
    );

    const c = fakeWorld();
    c.world.cf.zones.clear();
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: false }, c.providers, () => {}))).toMatch(/zone/);

    const d = fakeWorld();
    d.world.cf.cnames.set("iiif.acme.example.test", { content: "elsewhere.example.test", proxied: true });
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, d.providers, () => {}))).toMatch(
      /already points at elsewhere/,
    );
  });

  it("stops before creating anything while any tenant of the federation has pending work", async () => {
    const a = fakeWorld();
    a.world.d1.openRuns = 1;
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, a.providers, () => {}))).toMatch(
      /The federation's tenants have 1 open run/,
    );
    expect(a.world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
    expect(a.world.d1.pendingScopes).toEqual([{ federationId: FAKE_FEDERATION_ID }]);

    const b = fakeWorld();
    b.world.d1.unpublishedVolumes = 2;
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, b.providers, () => {}))).toMatch(
      /2 volume\(s\) prepared or ready but not published/,
    );
    expect(b.world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
  });

  it("stops when another federation already names the bucket", async () => {
    const { world, providers } = fakeWorld();
    world.d1.federations.push({ ...emptyFederation("other", "other"), manifest_bucket: "acme-manifests" });
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: false }, providers, () => {}))).toMatch(
      /Federation other already has manifest_bucket/,
    );
  });

  it("stops on a value another federation has in any unique column before touching a bucket, key or secret", async () => {
    const taken: Array<[keyof DestinationValues, string]> = [
      ["pipeline_tiles_bucket", "acme-iiif-tiles"],
      ["pipeline_masters_bucket", "acme-masters"],
      ["manifest_bucket", "acme-manifests"],
      ["manifest_base_url", "https://manifests.acme.example.test"],
      ["storage_secret_prefix", "FEDERATION_ACME"],
    ];
    for (const [column, value] of taken) {
      for (const apply of [false, true]) {
        const { world, providers } = fakeWorld();
        world.d1.federations.push({ ...emptyFederation("other", "other"), [column]: value });
        expect(await stopped(provisionFederationStorage({ ...OPTS, apply }, providers, () => {}))).toBe(
          `Federation other already has ${column} ${value}`,
        );
        expect(world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
        expect(world.d1.writes).toBe(0);
      }
    }
  });

  it("goes ahead when other federations' records name other storage", async () => {
    const { world, providers } = fakeWorld();
    world.d1.federations.push({
      ...emptyFederation("other", "other"),
      pipeline_tiles_bucket: "other-iiif-tiles",
      pipeline_masters_bucket: "other-masters",
      manifest_bucket: "other-manifests",
      manifest_base_url: "https://manifests.other.example.test",
      storage_secret_prefix: "FEDERATION_OTHER",
    });
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.d1.writes).toBe(1);
  });

  it("prints steps as unchecked without credentials, and refuses to apply without them", async () => {
    const { providers } = fakeWorld();
    const bare = { ...providers, b2: null, cloudflare: null, github: null, worker: null };
    const out = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, bare, out.log);
    expect(out.text()).toContain("[unchecked] B2 buckets acme-iiif-tiles, acme-masters and acme-review-tiles");
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, bare, () => {}))).toMatch(/credentials/);
  });

  it("refuses the local target", async () => {
    const { providers } = fakeWorld();
    expect(await stopped(provisionFederationStorage({ ...OPTS, target: "local", apply: false }, providers, () => {}))).toMatch(
      /staging or production/,
    );
  });
});

describe("provisioning with an existing masters bucket", () => {
  const SHARED = "shared-masters";

  function withShared(bucketType: "allPrivate" | "allPublic" = "allPrivate") {
    const w = fakeWorld();
    w.world.b2.buckets.set(SHARED, { bucketId: "bucket-shared", bucketName: SHARED, bucketType, corsRules: [] });
    return w;
  }

  it("dry run: prints the bucket as adopted, creates nothing, and plans the list key on it", async () => {
    const { world, providers } = withShared();
    const out = capture();
    const values = await provisionFederationStorage({ ...STAGING, mastersBucket: SHARED, apply: false }, providers, out.log);
    expect(values.pipeline_masters_bucket).toBe(SHARED);
    expect(values.pipeline_tiles_bucket).toBe("acme-staging-iiif-tiles");
    expect(writeCalls(world.calls)).toEqual([]);
    expect(world.d1.writes).toBe(0);
    expect(out.text()).toContain("masters bucket (B2, private): shared-masters (existing, adopted)");
    expect(out.text()).toContain("  [exists] B2 bucket shared-masters, private (adopted)");
    expect(out.text()).not.toMatch(/acme-staging-masters(?!-list)/);
    expect(out.text()).toContain("would create B2 bucket acme-staging-iiif-tiles");
    expect(out.text()).toContain("would create R2 bucket acme-staging-manifests");
    expect(out.text()).toContain(
      "would issue fisqua-acme-staging-masters-list: B2 key, list only, limited to shared-masters (Fisqua)",
    );
    expect(out.text()).toContain("pipeline_masters_bucket: (empty) -> shared-masters");
  });

  it("apply: creates the other storage, no masters bucket, and records the one given", async () => {
    const { world, providers } = withShared();
    const out = capture();
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED, apply: true }, providers, out.log);
    expect(world.calls.filter((c) => c.startsWith("b2.createBucket:"))).toEqual([
      "b2.createBucket:acme-iiif-tiles",
      "b2.createBucket:acme-review-tiles",
    ]);
    // The adopted bucket is changed only by its role tag.
    expect(world.calls.filter((c) => c.startsWith("b2.updateBucket"))).toEqual(["b2.updateBucket"]);
    expect(world.b2.buckets.has("acme-masters")).toBe(false);
    expect(world.b2.buckets.get(SHARED)).toEqual({
      bucketId: "bucket-shared", bucketName: SHARED, bucketType: "allPrivate", corsRules: [],
      bucketInfo: { "fisqua-role": "masters", "fisqua-federation": "acme" },
      revision: 2,
    });
    expect(world.cf.r2.has("acme-manifests")).toBe(true);
    expect([...world.cf.cnames.keys()]).toEqual(["iiif.acme.example.test"]);
    expect(world.b2.keys.map((k) => [k.name, k.bucketId, k.capabilities])).toEqual([
      ["fisqua-acme-tiles-fisqua-read", world.b2.buckets.get("acme-iiif-tiles")!.bucketId, expect.any(Array)],
      ["fisqua-acme-masters-list", "bucket-shared", ["listBuckets", "listFiles"]],
      ["fisqua-acme-review-tiles-fisqua-share", world.b2.buckets.get("acme-review-tiles")!.bucketId, expect.any(Array)],
    ]);
    expect(world.worker.size).toBe(8);
    expect(world.d1.federations[0]).toMatchObject({
      pipeline_tiles_bucket: "acme-iiif-tiles",
      pipeline_masters_bucket: SHARED,
      manifest_bucket: "acme-manifests",
    });
    for (const value of world.issued) expect(out.text()).not.toContain(value);

    const callsBefore = world.calls.length;
    const again = capture();
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED, apply: true }, providers, again.log);
    expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    expect(again.text()).toContain("already holds this destination");
    expect(again.text()).not.toContain("[reissue]");
  });

  it("stops before creating anything when the bucket is missing or not private", async () => {
    const cases: Array<[() => ReturnType<typeof fakeWorld>, RegExp]> = [
      [() => fakeWorld(), /The masters bucket shared-masters is not in the B2 account; it is adopted, not created/],
      [() => withShared("allPublic"), /The masters bucket shared-masters is allPublic, not allPrivate/],
    ];
    for (const [make, message] of cases) {
      for (const apply of [false, true]) {
        const { world, providers } = make();
        expect(await stopped(provisionFederationStorage({ ...OPTS, mastersBucket: SHARED, apply }, providers, () => {}))).toMatch(
          message,
        );
        expect(writeCalls(world.calls)).toEqual([]);
        expect(world.calls.filter((c) => c.startsWith("cf."))).toEqual([]);
        expect(world.b2.keys).toEqual([]);
        expect(world.worker.size).toBe(0);
        expect(world.d1.writes).toBe(0);
      }
    }
  });

  it("stops before touching anything when another federation records the bucket", async () => {
    for (const apply of [false, true]) {
      const { world, providers } = withShared();
      world.d1.federations.push({ ...emptyFederation("other", "other"), pipeline_masters_bucket: SHARED });
      expect(await stopped(provisionFederationStorage({ ...OPTS, mastersBucket: SHARED, apply }, providers, () => {}))).toBe(
        `Federation other already has pipeline_masters_bucket ${SHARED}`,
      );
      expect(world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
      expect(world.d1.writes).toBe(0);
    }
  });

  it("issues the list key again when the federation records another masters bucket", async () => {
    const { world, providers } = withShared();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    const before = world.worker.get("FEDERATION_ACME_MASTERS_LIST_KEY_ID");
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(
      "[reissue] would issue fisqua-acme-masters-list again: B2 key, list only, limited to shared-masters (Fisqua)",
    );
    expect(dry.text()).toContain("because the masters bucket changes from acme-masters to shared-masters");
    expect(dry.text()).toContain("[would replace] FEDERATION_ACME_MASTERS_LIST_KEY_ID");
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED, apply: true }, providers, () => {});
    expect(world.b2.keys.filter((k) => k.name === "fisqua-acme-masters-list").map((k) => k.bucketId)).toEqual([
      world.b2.buckets.get("acme-masters")!.bucketId,
      "bucket-shared",
    ]);
    expect(world.worker.get("FEDERATION_ACME_MASTERS_LIST_KEY_ID")).not.toBe(before);
    expect(world.d1.federations[0].pipeline_masters_bucket).toBe(SHARED);
    expect(world.calls.filter((c) => /delete/i.test(c))).toEqual([]);
  });

  it("refuses a bucket name of the wrong form before reading anything", async () => {
    const { world, providers } = withShared();
    expect(await stopped(provisionFederationStorage({ ...OPTS, mastersBucket: "Bad_Masters", apply: false }, providers, () => {}))).toMatch(
      /Not a bucket name/,
    );
    expect(world.calls).toEqual([]);
  });

  it("passes the flag from the command line, and without it creates {slug}-masters as before", async () => {
    const flagged = withShared();
    const out = capture();
    await runFederationCommand(
      parseArgs(["--federation", "acme", "--domain", "acme.example.test", "--target", "staging", "--masters-bucket", SHARED]),
      flagged.providers,
      out.log,
    );
    expect(out.text()).toContain("[exists] B2 bucket shared-masters, private (adopted)");
    expect(out.text()).not.toMatch(/acme-staging-masters(?!-list)/);

    const plain = withShared();
    const without = capture();
    await runFederationCommand(
      parseArgs(["--federation", "acme", "--domain", "acme.example.test", "--target", "staging"]),
      plain.providers,
      without.log,
    );
    const reference = fakeWorld();
    reference.world.b2.buckets.set(SHARED, { bucketId: "bucket-shared", bucketName: SHARED, bucketType: "allPrivate", corsRules: [] });
    const direct = capture();
    await provisionFederationStorage({ ...STAGING, apply: false }, reference.providers, direct.log);
    direct.log("\nDry run: nothing was written. Run with --apply to write.");
    expect(without.lines).toEqual(direct.lines);
    expect(without.text()).toContain("would create B2 bucket acme-staging-masters, private, no CORS rule, no host");
    expect(without.text()).not.toContain("adopted");
  });
});

describe("adopting a federation's storage", () => {
  const VALUES: DestinationValues = {
    pipeline_delivery_endpoint: FAKE_B2_S3,
    pipeline_tiles_bucket: "existing-iiif-tiles",
    pipeline_masters_bucket: "existing-masters",
    pipeline_image_base_url: "https://iiif.existing.example.test",
    manifest_endpoint: FAKE_R2_S3,
    manifest_bucket: "existing-manifests",
    manifest_base_url: "https://manifests.existing.example.test",
    storage_secret_prefix: "FEDERATION_NEOGRANADINA",
  };
  const OPTS_ADOPT = { slug: "neogranadina", target: "production" as const, values: VALUES };

  function existing() {
    const w = fakeWorld({ federation: "neogranadina", tenant: "neogranadina" });
    for (const [name, bucketType, corsRules] of [
      ["existing-iiif-tiles", "allPublic", B2_CORS_RULES],
      ["existing-masters", "allPrivate", []],
      ["moved-iiif-tiles", "allPublic", B2_CORS_RULES],
    ] as const) {
      w.world.b2.buckets.set(name, { bucketId: `bucket-${name}`, bucketName: name, bucketType, corsRules: [...corsRules] });
    }
    w.world.cf.r2.add("existing-manifests");
    w.world.cf.r2.add("moved-manifests");
    return w;
  }

  it("dry run issues and writes nothing, and shows Fisqua's keys and the record", async () => {
    const { world, providers } = existing();
    const out = capture();
    await adoptFederationStorage({ ...OPTS_ADOPT, apply: false }, providers, out.log);
    expect(writeCalls(world.calls)).toEqual([]);
    expect(world.d1.writes).toBe(0);
    expect(out.text()).toContain("[exists] B2 masters bucket existing-masters, private");
    expect(out.text()).toContain("would issue fisqua-neogranadina-tiles-fisqua-read");
    expect(out.text()).toContain("would issue fisqua-neogranadina-manifests-write");
    expect(out.text()).toContain("[would set] FEDERATION_NEOGRANADINA_MANIFEST_WRITE_SECRET_KEY");
    expect(out.text()).toContain("would create B2 bucket neogranadina-review-tiles, private, no lifecycle rule");
    expect(out.text()).toContain("would issue fisqua-neogranadina-review-tiles-fisqua-share");
    expect(out.text()).toContain("[would set] FEDERATION_NEOGRANADINA_REVIEW_SHARE_SECRET_KEY");
    expect(out.text()).toContain("would write 9 column(s) to the federation record");
  });

  it("apply: issues Fisqua's keys, writes the record, and creates no bucket but the review-tiles bucket, no host and no runner key", async () => {
    const { world, providers } = existing();
    const out = capture();
    await adoptFederationStorage({ ...OPTS_ADOPT, apply: true }, providers, out.log);
    const review = world.b2.buckets.get("neogranadina-review-tiles")!;
    expect(review).toMatchObject({ bucketType: "allPrivate", corsRules: reviewTilesCorsRules("production") });
    expect(world.b2.keys.map((k) => [k.name, k.bucketId, k.namePrefix ?? null])).toEqual([
      ["fisqua-neogranadina-tiles-fisqua-read", "bucket-existing-iiif-tiles", null],
      ["fisqua-neogranadina-masters-list", "bucket-existing-masters", null],
      ["fisqua-neogranadina-review-tiles-fisqua-share", review.bucketId, null],
    ]);
    expect(world.cf.tokens).toEqual([{ name: "fisqua-neogranadina-manifests-write", bucket: "existing-manifests" }]);
    expect(world.worker.size).toBe(8);
    expect(world.d1.federations[0]).toMatchObject({ ...VALUES, pipeline_review_tiles_bucket: "neogranadina-review-tiles" });
    const created = world.calls.filter(
      (c) => /^b2\.(createBucket|updateBucket)/.test(c) || /^cf\.(create(R2Bucket|Cname)|put|add)/.test(c) || c.startsWith("gh."),
    );
    expect(created).toEqual(["b2.updateBucket", "b2.updateBucket", "b2.createBucket:neogranadina-review-tiles"]);
    // The two updates only tag the adopted buckets.
    expect(world.b2.buckets.get("existing-iiif-tiles")!.bucketInfo).toEqual({
      "fisqua-role": "tiles", "fisqua-env": "production", "fisqua-federation": "neogranadina",
    });
    expect(world.b2.buckets.get("existing-iiif-tiles")!.corsRules).toEqual(B2_CORS_RULES);
    expect(world.b2.buckets.get("existing-masters")!.bucketInfo).toEqual({
      "fisqua-role": "masters", "fisqua-federation": "neogranadina",
    });
    for (const value of world.issued) expect(out.text()).not.toContain(value);

    const callsBefore = world.calls.length;
    const again = capture();
    await adoptFederationStorage({ ...OPTS_ADOPT, apply: true }, providers, again.log);
    expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    expect(again.text()).toContain("already holds this destination");
    expect(again.text()).not.toContain("[reissue]");
  });

  it("re-adopting with another tiles bucket issues Fisqua's read key again and names the tenants to follow", async () => {
    const { world, providers } = existing();
    await adoptFederationStorage({ ...OPTS_ADOPT, apply: true }, providers, () => {});
    const before = new Map(world.worker);
    const moved = { ...VALUES, pipeline_tiles_bucket: "moved-iiif-tiles" };
    const dry = capture();
    await adoptFederationStorage({ ...OPTS_ADOPT, values: moved, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(
      "[reissue] would issue fisqua-neogranadina-tiles-fisqua-read again: B2 key, read, limited to moved-iiif-tiles (Fisqua), " +
        "and replace the secrets that hold it, because the tiles bucket changes from existing-iiif-tiles to moved-iiif-tiles " +
        "and the key held is limited to existing-iiif-tiles; the older key fisqua-neogranadina-tiles-fisqua-read is left in place, " +
        "to be deleted by hand once the new one is in use",
    );
    expect(dry.text()).toContain("[exists] fisqua-neogranadina-manifests-write");
    expect(dry.text()).toContain("[would replace] FEDERATION_NEOGRANADINA_DELIVERY_READ_KEY_ID");
    expect(dry.text()).toContain(
      "[note] the runner keys of neogranadina are limited to the old tiles bucket; run provision-tenant-storage",
    );

    await adoptFederationStorage({ ...OPTS_ADOPT, values: moved, apply: true }, providers, () => {});
    expect(world.b2.keys.filter((k) => k.name.endsWith("-tiles-fisqua-read")).map((k) => k.bucketId)).toEqual([
      "bucket-existing-iiif-tiles",
      "bucket-moved-iiif-tiles",
    ]);
    expect(world.worker.get("FEDERATION_NEOGRANADINA_DELIVERY_READ_KEY_ID")).not.toBe(
      before.get("FEDERATION_NEOGRANADINA_DELIVERY_READ_KEY_ID"),
    );
    expect(world.worker.get("FEDERATION_NEOGRANADINA_MANIFEST_WRITE_KEY_ID")).toBe(
      before.get("FEDERATION_NEOGRANADINA_MANIFEST_WRITE_KEY_ID"),
    );
    expect(world.calls.filter((c) => /delete/i.test(c))).toEqual([]);
  });

  it("issues the masters list key only where its secrets are not set, and again for another masters bucket", async () => {
    const { world, providers } = existing();
    world.b2.buckets.set("moved-masters", { bucketId: "bucket-moved-masters", bucketName: "moved-masters", bucketType: "allPrivate", corsRules: [] });
    world.worker.set("FEDERATION_NEOGRANADINA_DELIVERY_READ_KEY_ID", "held");
    world.worker.set("FEDERATION_NEOGRANADINA_DELIVERY_READ_SECRET_KEY", "held");
    world.worker.set("FEDERATION_NEOGRANADINA_MANIFEST_WRITE_KEY_ID", "held");
    world.worker.set("FEDERATION_NEOGRANADINA_MANIFEST_WRITE_SECRET_KEY", "held");
    world.worker.set("FEDERATION_NEOGRANADINA_REVIEW_SHARE_KEY_ID", "held");
    world.worker.set("FEDERATION_NEOGRANADINA_REVIEW_SHARE_SECRET_KEY", "held");
    // The held secrets' keys are live in the accounts.
    world.b2.buckets.set("neogranadina-review-tiles", { bucketId: "bucket-review", bucketName: "neogranadina-review-tiles", bucketType: "allPrivate", corsRules: [] });
    world.b2.keys.push(
      { name: "fisqua-neogranadina-tiles-fisqua-read", bucketId: "bucket-existing-iiif-tiles", capabilities: ["listBuckets", "listFiles", "readFiles"] },
      { name: "fisqua-neogranadina-review-tiles-fisqua-share", bucketId: "bucket-review", capabilities: ["listBuckets", "listFiles", "readFiles", "shareFiles"] },
    );
    world.cf.tokens.push({ name: "fisqua-neogranadina-manifests-write", bucket: "existing-manifests" });
    const live = world.b2.keys.length;
    const dry = capture();
    await adoptFederationStorage({ ...OPTS_ADOPT, apply: false }, providers, dry.log);
    expect(dry.text()).toContain("[exists] fisqua-neogranadina-tiles-fisqua-read");
    expect(dry.text()).toContain("would issue fisqua-neogranadina-masters-list: B2 key, list only, limited to existing-masters (Fisqua)");
    expect(dry.text()).toContain("[would set] FEDERATION_NEOGRANADINA_MASTERS_LIST_KEY_ID");
    expect(world.b2.keys).toHaveLength(live);

    await adoptFederationStorage({ ...OPTS_ADOPT, apply: true }, providers, () => {});
    expect(world.b2.keys.slice(live).map((k) => [k.name, k.bucketId, k.capabilities])).toEqual([
      ["fisqua-neogranadina-masters-list", "bucket-existing-masters", ["listBuckets", "listFiles"]],
    ]);
    expect(world.worker.get("FEDERATION_NEOGRANADINA_DELIVERY_READ_KEY_ID")).toBe("held");

    const moved = { ...VALUES, pipeline_masters_bucket: "moved-masters" };
    const again = capture();
    await adoptFederationStorage({ ...OPTS_ADOPT, values: moved, apply: false }, providers, again.log);
    expect(again.text()).toContain("[reissue] would issue fisqua-neogranadina-masters-list again");
    expect(again.text()).toContain("[would replace] FEDERATION_NEOGRANADINA_MASTERS_LIST_SECRET_KEY");
    await adoptFederationStorage({ ...OPTS_ADOPT, values: moved, apply: true }, providers, () => {});
    expect(world.b2.keys.slice(live).map((k) => k.bucketId)).toEqual(["bucket-existing-masters", "bucket-moved-masters"]);
  });

  it("re-adopting with another manifest bucket issues the write token again", async () => {
    const { world, providers } = existing();
    await adoptFederationStorage({ ...OPTS_ADOPT, apply: true }, providers, () => {});
    const moved = { ...VALUES, manifest_bucket: "moved-manifests" };
    const dry = capture();
    await adoptFederationStorage({ ...OPTS_ADOPT, values: moved, apply: false }, providers, dry.log);
    expect(dry.text()).toContain("[reissue] would issue fisqua-neogranadina-manifests-write again");
    expect(dry.text()).toContain("because the manifest bucket changes from existing-manifests to moved-manifests");
    await adoptFederationStorage({ ...OPTS_ADOPT, values: moved, apply: true }, providers, () => {});
    expect(world.cf.tokens.map((t) => t.bucket)).toEqual(["existing-manifests", "moved-manifests"]);
  });

  it("stops on a value another federation has in any unique column before issuing a key or setting a secret", async () => {
    const OTHER_SECRETS = [
      "FEDERATION_OTHER_DELIVERY_READ_KEY_ID",
      "FEDERATION_OTHER_DELIVERY_READ_SECRET_KEY",
      "FEDERATION_OTHER_MANIFEST_WRITE_KEY_ID",
      "FEDERATION_OTHER_MANIFEST_WRITE_SECRET_KEY",
    ];
    const cases: Array<[keyof DestinationValues, string]> = [
      ["pipeline_tiles_bucket", "other-iiif-tiles"],
      ["pipeline_masters_bucket", "other-masters"],
      ["manifest_bucket", "other-manifests"],
      ["manifest_base_url", "https://manifests.other.example.test"],
      // --secret-prefix naming another federation's prefix.
      ["storage_secret_prefix", "FEDERATION_OTHER"],
    ];
    for (const [column, value] of cases) {
      for (const apply of [false, true]) {
        const { world, providers } = existing();
        world.b2.buckets.set("other-iiif-tiles", { bucketId: "bucket-other-tiles", bucketName: "other-iiif-tiles", bucketType: "allPublic", corsRules: [...B2_CORS_RULES] });
        world.b2.buckets.set("other-masters", { bucketId: "bucket-other-masters", bucketName: "other-masters", bucketType: "allPrivate", corsRules: [] });
        world.cf.r2.add("other-manifests");
        for (const name of OTHER_SECRETS) world.worker.set(name, "other-held");
        world.d1.federations.push({ ...emptyFederation("other", "other"), [column]: value });
        const values = { ...VALUES, [column]: value };
        expect(await stopped(adoptFederationStorage({ ...OPTS_ADOPT, values, apply }, providers, () => {}))).toBe(
          `Federation other already has ${column} ${value}`,
        );
        expect(writeCalls(world.calls)).toEqual([]);
        expect(world.b2.keys).toEqual([]);
        expect(world.cf.tokens).toEqual([]);
        expect([...world.worker.values()]).toEqual(OTHER_SECRETS.map(() => "other-held"));
        expect(world.d1.writes).toBe(0);
      }
    }
  });

  it("adopts when other federations' records name other storage", async () => {
    const { world, providers } = existing();
    world.d1.federations.push({
      ...emptyFederation("other", "other"),
      pipeline_tiles_bucket: "other-iiif-tiles",
      pipeline_masters_bucket: "other-masters",
      manifest_bucket: "other-manifests",
      manifest_base_url: "https://manifests.other.example.test",
      storage_secret_prefix: "FEDERATION_OTHER",
    });
    await adoptFederationStorage({ ...OPTS_ADOPT, apply: true }, providers, () => {});
    expect(world.b2.keys).toHaveLength(3);
    expect(world.worker.size).toBe(8);
    expect(world.d1.writes).toBe(1);
  });

  it("stops when an endpoint is not the account's, or a bucket is missing or of the wrong kind", async () => {
    const cases: Array<[Partial<DestinationValues>, (w: ReturnType<typeof existing>) => void, RegExp]> = [
      [{ pipeline_delivery_endpoint: "https://s3.elsewhere.example.test" }, () => {}, /not the B2 account's S3 endpoint/],
      [{ manifest_endpoint: "https://other.r2.cloudflarestorage.com" }, () => {}, /not the Cloudflare account's R2 endpoint/],
      [{}, (w) => w.world.b2.buckets.delete("existing-iiif-tiles"), /existing-iiif-tiles is not in the B2 account/],
      [{}, (w) => w.world.b2.buckets.delete("existing-masters"), /masters bucket existing-masters is not in the B2 account; adoption does not create it/],
      [{}, (w) => (w.world.b2.buckets.get("existing-masters")!.bucketType = "allPublic"), /existing-masters is allPublic, not allPrivate/],
      [{}, (w) => w.world.cf.r2.delete("existing-manifests"), /existing-manifests is not in the Cloudflare account/],
    ];
    for (const [over, setup, message] of cases) {
      const w = existing();
      setup(w);
      expect(await stopped(adoptFederationStorage({ ...OPTS_ADOPT, values: { ...VALUES, ...over }, apply: true }, w.providers, () => {}))).toMatch(message);
      expect(w.world.b2.keys).toEqual([]);
      expect(w.world.calls.filter((c) => c.startsWith("b2.createBucket"))).toEqual([]);
    }
  });

  it("stops before issuing a key while a tenant of the federation has unpublished volumes", async () => {
    const { world, providers } = existing();
    world.d1.unpublishedVolumes = 1;
    expect(await stopped(adoptFederationStorage({ ...OPTS_ADOPT, apply: true }, providers, () => {}))).toMatch(
      /prepared or ready but not published/,
    );
    expect(world.b2.keys).toEqual([]);
    expect(world.cf.tokens).toEqual([]);
  });

  it("on local issues no key and writes only the record", async () => {
    const { world, providers } = existing();
    const out = capture();
    await adoptFederationStorage({ ...OPTS_ADOPT, target: "local", apply: true }, { ...providers, worker: null }, out.log);
    expect(world.b2.keys).toEqual([]);
    expect(world.d1.writes).toBe(1);
    expect(out.text()).toContain(".dev.vars");
  });

  it("refuses values of the wrong form before reading anything", async () => {
    const { world, providers } = existing();
    for (const bad of [
      { pipeline_delivery_endpoint: "http://s3.example.test" },
      { manifest_base_url: "https://manifests.example.test/iiif" },
      { storage_secret_prefix: "lower" },
      { manifest_bucket: "Bad_Bucket" },
      { pipeline_masters_bucket: "Bad_Masters" },
    ]) {
      await expect(
        adoptFederationStorage({ ...OPTS_ADOPT, apply: true, values: { ...VALUES, ...bad } }, providers, () => {}),
      ).rejects.toBeInstanceOf(ProvisionStop);
    }
    expect(world.calls).toEqual([]);
  });

  it("is refused for any federation but Neogranadina's", async () => {
    const { providers } = fakeWorld();
    const options = parseArgs([
      "--federation", "acme", "--adopt", "--target", "staging",
      "--tiles-bucket", "t-bucket", "--tiles-endpoint", FAKE_B2_S3, "--image-base-url", "https://i.example.test",
      "--masters-bucket", "m-bucket", "--manifest-bucket", "mf-bucket", "--manifest-endpoint", FAKE_R2_S3,
      "--manifest-base-url", "https://mm.example.test",
    ]);
    expect(await stopped(runFederationCommand(options, providers, () => {}))).toMatch(/Only Neogranadina's existing storage/);
  });
});

describe("federation arguments", () => {
  const ADOPT = [
    "--federation", "neogranadina", "--adopt", "--target", "staging",
    "--tiles-bucket", "t", "--tiles-endpoint", "https://e.example.test", "--image-base-url", "https://i.example.test/",
    "--manifest-bucket", "m", "--manifest-endpoint", "https://r.example.test", "--masters-bucket", "mb",
    "--manifest-base-url", "https://mm.example.test",
  ];
  const PROVISION = ["--federation", "acme", "--domain", "acme.example.test"];

  it("needs --confirm-production to apply against production, and is a dry run by default", () => {
    expect(() => parseArgs([...PROVISION, "--target", "production", "--apply"])).toThrow(/confirm-production/);
    expect(parseArgs([...PROVISION, "--target", "production", "--apply", "--confirm-production"]).apply).toBe(true);
    expect(parseArgs([...PROVISION, "--target", "production"]).apply).toBe(false);
  });

  it("needs a domain to provision, and no storage flag but --masters-bucket", () => {
    expect(() => parseArgs(["--federation", "acme", "--target", "staging"])).toThrow(/--domain/);
    expect(() => parseArgs([...PROVISION, "--target", "staging", "--tiles-bucket", "x"])).toThrow(/--adopt only/);
    expect(() =>
      parseArgs([...PROVISION, "--target", "staging", "--masters-bucket", "mb", "--manifest-bucket", "x"]),
    ).toThrow(/other than --masters-bucket are for --adopt only/);
    const options = parseArgs([...PROVISION, "--target", "staging", "--masters-bucket", "mb"]);
    expect(options.adopt).toBe(false);
    expect(options.adoptValues).toEqual({ pipeline_masters_bucket: "mb" });
    expect(parseArgs([...PROVISION, "--target", "staging"]).adoptValues).toEqual({});
    expect(() => parseArgs([...PROVISION, "--target", "local"])).toThrow(/staging or production/);
  });

  it("needs every address and the masters bucket as flags to adopt", () => {
    expect(() => parseArgs(ADOPT.slice(0, -2))).toThrow(/--manifest-base-url/);
    const noMasters = ADOPT.filter((a, i) => a !== "--masters-bucket" && ADOPT[i - 1] !== "--masters-bucket");
    expect(() => parseArgs(noMasters)).toThrow(/--adopt needs --masters-bucket/);
    expect(() => parseArgs([...ADOPT, "--domain", "x.example.test"])).toThrow(/not --domain/);
    const values = adoptValuesFrom(parseArgs(ADOPT));
    expect(values.pipeline_masters_bucket).toBe("mb");
    expect(values.pipeline_image_base_url).toBe("https://i.example.test");
    expect(values.storage_secret_prefix).toBe("FEDERATION_NEOGRANADINA");
  });
});

describe("federation D1 statements", () => {
  it("one UPDATE of the eight columns, scoped to the federation", () => {
    const values: DestinationValues = {
      pipeline_delivery_endpoint: "https://e.example.test",
      pipeline_tiles_bucket: "t",
      pipeline_masters_bucket: "mb",
      pipeline_image_base_url: "https://i.example.test",
      manifest_endpoint: "https://r.example.test",
      manifest_bucket: "m",
      manifest_base_url: "https://mm.example.test",
      storage_secret_prefix: "P'X",
    };
    expect(destinationStatement("id-1", values)).toBe(
      "UPDATE federations SET pipeline_delivery_endpoint = 'https://e.example.test', pipeline_tiles_bucket = 't', " +
        "pipeline_masters_bucket = 'mb', pipeline_image_base_url = 'https://i.example.test', " +
        "manifest_endpoint = 'https://r.example.test', manifest_bucket = 'm', " +
        "manifest_base_url = 'https://mm.example.test', storage_secret_prefix = 'P''X' WHERE id = 'id-1';",
    );
  });

  it("pending work counts open runs and prepared or ready volumes across the federation's tenants", () => {
    const where = "tenant_id IN (SELECT id FROM tenants WHERE federation_id = 'f''1')";
    expect(pendingWorkStatement({ federationId: "f'1" }, 42)).toBe(
      `SELECT (SELECT COUNT(*) FROM pipeline_runs WHERE ${where} ` +
        "AND token_revoked_at IS NULL AND token_expires_at > 42) AS open_runs, " +
        `(SELECT COUNT(*) FROM pipeline_volumes WHERE ${where} ` +
        "AND state IN ('prepared', 'ready')) AS unpublished_volumes",
    );
  });
});

describe("the review-tiles bucket", () => {
  /** A federation provisioned in production before the review-tiles bucket existed. */
  function withoutReview() {
    const w = fakeWorld();
    return w;
  }

  async function provisionedBefore() {
    const w = withoutReview();
    await provisionFederationStorage({ ...OPTS, apply: true }, w.providers, () => {});
    // Take the bucket, its key and its two secrets away, and clear the column.
    w.world.b2.buckets.delete("acme-review-tiles");
    w.world.b2.keys = w.world.b2.keys.filter((k) => !k.name.includes("review-tiles"));
    w.world.worker.delete("FEDERATION_ACME_REVIEW_SHARE_KEY_ID");
    w.world.worker.delete("FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY");
    w.world.d1.federations[0].pipeline_review_tiles_bucket = null;
    return w;
  }

  it("allows downloads from the target's tenant hosts only, never from any origin or the apex", () => {
    expect(reviewTilesOrigins("production")).toEqual(["https://*.fisqua.org"]);
    expect(reviewTilesOrigins("staging")).toEqual(["https://*.staging.fisqua.org"]);
    for (const target of ["production", "staging"] as const) {
      const rules = reviewTilesCorsRules(target) as Array<Record<string, unknown>>;
      expect(rules).toEqual([
        {
          corsRuleName: "review-tiles-read",
          allowedOrigins: reviewTilesOrigins(target),
          allowedOperations: ["b2_download_file_by_name", "s3_get", "s3_head"],
          allowedHeaders: ["authorization", "range"],
          exposeHeaders: [],
          maxAgeSeconds: 86400,
        },
      ]);
      const origins = rules[0].allowedOrigins as string[];
      expect(origins).not.toContain("*");
      expect(origins).not.toContain("https");
      // B2 takes one `*` per origin, inside the host.
      for (const origin of origins) expect(origin.split("*").length).toBeLessThanOrEqual(2);
      expect(String(rules[0].corsRuleName)).toMatch(/^(?!b2-)[A-Za-z0-9-]{6,63}$/);
    }
  });

  it("covers every tenant host wrangler.jsonc routes in each environment, and excludes the apex", () => {
    const path = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
    const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
    if (parsed.error) throw new Error("wrangler.jsonc did not parse");
    type Route = { pattern: string; custom_domain?: boolean };
    const config = parsed.config as { routes: Route[]; env: { staging: { routes: Route[] } } };
    const matches = (host: string, origin: string) => {
      const [scheme, pattern] = origin.split("://");
      if (scheme !== "https") return false;
      const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.]/g, "\\.")).join("[a-z0-9-]+")}$`);
      return re.test(host);
    };
    const hostsOf = (routes: Route[]) =>
      routes.map((r) => r.pattern.replace(/\/\*$/, "")).filter((h) => !h.includes("*"));
    const allowed = (target: "production" | "staging", host: string) =>
      reviewTilesOrigins(target).some((o) => matches(host, o));
    for (const [target, apex, routes] of [
      ["production", "fisqua.org", config.routes],
      ["staging", "staging.fisqua.org", config.env.staging.routes],
    ] as const) {
      const hosts = hostsOf(routes);
      // The apex is routed, and deliberately not allowed: it serves no tenant.
      expect(hosts).toContain(apex);
      expect(allowed(target, apex), `${target} apex ${apex}`).toBe(false);
      // Every other routed host is a tenant host one label under the apex.
      const tenants = hosts.filter((h) => h !== apex);
      for (const host of tenants) {
        expect(host.endsWith(`.${apex}`) && !host.slice(0, -apex.length - 1).includes("."), host).toBe(true);
        expect(allowed(target, host), `${target} ${host}`).toBe(true);
      }
    }
    // Production routes its tenant hosts by the wildcard `*fisqua.org/*`, not by name.
    expect(config.routes.map((r) => r.pattern)).toContain("*fisqua.org/*");
    expect(hostsOf(config.env.staging.routes).length).toBeGreaterThan(1);
    // A tenant host is one label under the target's apex.
    expect(reviewTilesOrigins("production").some((o) => matches("ahr.fisqua.org", o))).toBe(true);
    expect(reviewTilesOrigins("staging").some((o) => matches("ahr.staging.fisqua.org", o))).toBe(true);
    expect(reviewTilesOrigins("staging").some((o) => matches("ahr.fisqua.org", o))).toBe(false);
    expect(reviewTilesOrigins("production").some((o) => matches("fisqua.org.example.test", o))).toBe(false);
  });

  it("is created private with its CORS rule and no lifecycle rule, and found again on a rerun", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    const bucket = world.b2.buckets.get("acme-review-tiles")!;
    // The fake bucket holds exactly what was asked for: no lifecycle rule is sent.
    expect(Object.keys(bucket).sort()).toEqual(["bucketId", "bucketInfo", "bucketName", "bucketType", "corsRules"]);
    expect(bucket.bucketInfo).toEqual({ "fisqua-role": "review-tiles", "fisqua-env": "production", "fisqua-federation": "acme" });
    expect(bucket).toMatchObject({ bucketType: "allPrivate", corsRules: reviewTilesCorsRules("production") });
    const again = capture();
    const before = world.calls.length;
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, again.log);
    expect(writeCalls(world.calls.slice(before))).toEqual([]);
    expect(again.text()).toContain("[exists] B2 bucket acme-review-tiles, private, no lifecycle rule");
  });

  it("adopts an existing private bucket of its name, and sets its CORS rule when it differs", async () => {
    const a = fakeWorld();
    a.world.b2.buckets.set("acme-review-tiles", {
      bucketId: "bucket-review", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [...reviewTilesCorsRules("production")],
    });
    const out = capture();
    await provisionFederationStorage({ ...OPTS, apply: true }, a.providers, out.log);
    expect(a.world.calls).not.toContain("b2.createBucket:acme-review-tiles");
    expect(out.text()).toContain("[update] B2 bucket acme-review-tiles: tagged as the production review-tiles bucket of federation acme");
    expect(a.world.b2.keys.find((k) => k.name === "fisqua-acme-review-tiles-fisqua-share")!.bucketId).toBe("bucket-review");
    expect(a.world.d1.federations[0].pipeline_review_tiles_bucket).toBe("acme-review-tiles");

    // A rule from any origin, as the tiles bucket has, is replaced.
    const b = fakeWorld();
    b.world.b2.buckets.set("acme-review-tiles", {
      bucketId: "bucket-review", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [...B2_CORS_RULES],
    });
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, b.providers, dry.log);
    expect(dry.text()).toContain("[update] B2 bucket acme-review-tiles: CORS rules would be set");
    await provisionFederationStorage({ ...OPTS, apply: true }, b.providers, () => {});
    expect(b.world.b2.buckets.get("acme-review-tiles")!.corsRules).toEqual(reviewTilesCorsRules("production"));

    // Its rule behind another is not the rule wanted: B2 applies the first that matches.
    const c = fakeWorld();
    c.world.b2.buckets.set("acme-review-tiles", {
      bucketId: "bucket-review", bucketName: "acme-review-tiles", bucketType: "allPrivate",
      corsRules: [{ ...B2_CORS_RULES[0], corsRuleName: "first-rule" }, ...reviewTilesCorsRules("production")],
    });
    const order = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, c.providers, order.log);
    expect(order.text()).toContain("[update] B2 bucket acme-review-tiles: CORS rules would be set");

    // A public bucket of its name stops the command.
    const d = fakeWorld();
    d.world.b2.buckets.set("acme-review-tiles", {
      bucketId: "bucket-review", bucketName: "acme-review-tiles", bucketType: "allPublic", corsRules: [],
    });
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, d.providers, () => {}))).toMatch(
      /acme-review-tiles exists but is allPublic, not allPrivate/,
    );
    expect(d.world.b2.keys.some((k) => k.name.includes("review-tiles"))).toBe(false);
  });

  it("stops at a taken name", async () => {
    const { world, providers } = fakeWorld();
    world.b2.taken.add("acme-review-tiles");
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}))).toMatch(
      /acme-review-tiles is taken/,
    );
    expect(world.b2.keys.some((k) => k.name.includes("review-tiles"))).toBe(false);
    expect(world.d1.writes).toBe(0);
  });

  it("issues Fisqua's share key limited to the bucket with list, read and share only", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    const key = world.b2.keys.find((k) => k.name === "fisqua-acme-review-tiles-fisqua-share")!;
    expect(key.bucketId).toBe(world.b2.buckets.get("acme-review-tiles")!.bucketId);
    expect(key.namePrefix).toBeUndefined();
    expect(key.capabilities).toEqual(["listBuckets", "listFiles", "readFiles", "shareFiles"]);
    expect(key.capabilities).not.toContain("writeFiles");
    expect(key.capabilities).not.toContain("deleteFiles");
    const issued = world.issued;
    expect(world.worker.get("FEDERATION_ACME_REVIEW_SHARE_KEY_ID")).toBe(issued[issued.length - 2]);
    expect(world.worker.get("FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY")).toBe(issued[issued.length - 1]);
  });

  it("is added to a federation provisioned before it, even with pending work, leaving the rest as it is", async () => {
    const { world, providers } = await provisionedBefore();
    world.d1.openRuns = 1;
    world.d1.unpublishedVolumes = 2;
    const recordBefore = { ...world.d1.federations[0] };
    const keysBefore = world.b2.keys.map((k) => ({ ...k }));
    const secretsBefore = new Map(world.worker);

    const dry = capture();
    const before = world.calls.length;
    await provisionFederationStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(writeCalls(world.calls.slice(before))).toEqual([]);
    expect(dry.text()).toContain("[create] would create B2 bucket acme-review-tiles");
    expect(dry.text()).toContain("[create] would issue fisqua-acme-review-tiles-fisqua-share");
    expect(dry.text()).toContain("[exists] fisqua-acme-tiles-fisqua-read");
    expect(dry.text()).toContain("[exists] fisqua-acme-masters-list");
    expect(dry.text()).toContain("[would set] FEDERATION_ACME_REVIEW_SHARE_KEY_ID");
    expect(dry.text()).toContain("[exists] FEDERATION_ACME_MASTERS_LIST_KEY_ID");
    expect(dry.text()).toContain("pipeline_review_tiles_bucket: (empty) -> acme-review-tiles");
    expect(dry.text()).toContain("pipeline_tiles_bucket: unchanged");
    expect(dry.text()).toContain("would write 1 column(s) to the federation record");
    expect(dry.text()).not.toContain("[reissue]");

    const out = capture();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, out.log);
    expect(world.d1.federations[0]).toEqual({ ...recordBefore, pipeline_review_tiles_bucket: "acme-review-tiles" });
    expect(world.b2.keys.slice(0, keysBefore.length)).toEqual(keysBefore);
    expect(world.b2.keys.slice(keysBefore.length).map((k) => k.name)).toEqual(["fisqua-acme-review-tiles-fisqua-share"]);
    for (const [name, value] of secretsBefore) expect(world.worker.get(name)).toBe(value);
    expect(world.worker.size).toBe(secretsBefore.size + 2);
    expect(world.calls.filter((c) => c.startsWith("b2.createBucket:"))).toEqual([
      "b2.createBucket:acme-iiif-tiles",
      "b2.createBucket:acme-masters",
      "b2.createBucket:acme-review-tiles",
      "b2.createBucket:acme-review-tiles",
    ]);
    for (const value of world.issued) expect(out.text()).not.toContain(value);

    const again = capture();
    const callsBefore = world.calls.length;
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, again.log);
    expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    expect(again.text()).toContain("already holds this destination");
  });

  it("is refused while work is pending when the run changes a recorded column", async () => {
    // Another review-tiles bucket recorded.
    const a = await provisionedBefore();
    a.world.d1.federations[0].pipeline_review_tiles_bucket = "acme-old-review-tiles";
    a.world.d1.openRuns = 1;
    const before = a.world.calls.length;
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, a.providers, () => {}))).toMatch(/1 open run/);
    expect(a.world.calls.slice(before).filter((c) => !c.startsWith("d1."))).toEqual([]);

    // Another tiles bucket recorded.
    const b = await provisionedBefore();
    b.world.d1.federations[0].pipeline_tiles_bucket = "acme-other-tiles";
    b.world.d1.openRuns = 1;
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, b.providers, () => {}))).toMatch(/1 open run/);
    expect(b.world.d1.federations[0].pipeline_review_tiles_bucket).toBeNull();
  });

  it("issues the share key again when the record names another review-tiles bucket", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    world.d1.federations[0].pipeline_review_tiles_bucket = "acme-old-review-tiles";
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(
      "[reissue] would issue fisqua-acme-review-tiles-fisqua-share again: B2 key, list, read and share, limited to acme-review-tiles (Fisqua)",
    );
    expect(dry.text()).toContain("because the review-tiles bucket changes from acme-old-review-tiles to acme-review-tiles");
    expect(dry.text()).toContain("[would replace] FEDERATION_ACME_REVIEW_SHARE_KEY_ID");
    expect(dry.text()).toContain("[exists] FEDERATION_ACME_MASTERS_LIST_KEY_ID");
  });

  it("stops when another federation records the bucket, before anything is touched", async () => {
    for (const apply of [false, true]) {
      const { world, providers } = fakeWorld();
      world.d1.federations.push({ ...emptyFederation("other", "other"), pipeline_review_tiles_bucket: "acme-review-tiles" });
      expect(await stopped(provisionFederationStorage({ ...OPTS, apply }, providers, () => {}))).toBe(
        "Federation other already has pipeline_review_tiles_bucket acme-review-tiles",
      );
      expect(world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
    }
  });

  it("is added by adoption to Neogranadina's adopted storage, with pending work, leaving the rest as it is", async () => {
    const VALUES: DestinationValues = {
      pipeline_delivery_endpoint: FAKE_B2_S3,
      pipeline_tiles_bucket: "existing-iiif-tiles",
      pipeline_masters_bucket: "existing-masters",
      pipeline_image_base_url: "https://iiif.existing.example.test",
      manifest_endpoint: FAKE_R2_S3,
      manifest_bucket: "existing-manifests",
      manifest_base_url: "https://manifests.existing.example.test",
      storage_secret_prefix: "FEDERATION_NEOGRANADINA",
    };
    const { world, providers } = fakeWorld({ federation: "neogranadina", tenant: "neogranadina" });
    world.b2.buckets.set("existing-iiif-tiles", { bucketId: "b-t", bucketName: "existing-iiif-tiles", bucketType: "allPublic", corsRules: [...B2_CORS_RULES] });
    world.b2.buckets.set("existing-masters", { bucketId: "b-m", bucketName: "existing-masters", bucketType: "allPrivate", corsRules: [] });
    world.cf.r2.add("existing-manifests");
    Object.assign(world.d1.federations[0], VALUES);
    for (const suffix of [
      "DELIVERY_READ_KEY_ID", "DELIVERY_READ_SECRET_KEY", "MANIFEST_WRITE_KEY_ID",
      "MANIFEST_WRITE_SECRET_KEY", "MASTERS_LIST_KEY_ID", "MASTERS_LIST_SECRET_KEY",
    ]) {
      world.worker.set(`FEDERATION_NEOGRANADINA_${suffix}`, "held");
    }
    // The held secrets' keys are live in the accounts.
    world.b2.keys.push(
      { name: "fisqua-neogranadina-tiles-fisqua-read", bucketId: "b-t", capabilities: ["listBuckets", "listFiles", "readFiles"] },
      { name: "fisqua-neogranadina-masters-list", bucketId: "b-m", capabilities: ["listBuckets", "listFiles"] },
    );
    world.cf.tokens.push({ name: "fisqua-neogranadina-manifests-write", bucket: "existing-manifests" });
    world.d1.openRuns = 3;
    const dry = capture();
    await adoptFederationStorage({ slug: "neogranadina", target: "production", values: VALUES, apply: false }, providers, dry.log);
    expect(writeCalls(world.calls)).toEqual([]);
    expect(dry.text()).toContain("would create B2 bucket neogranadina-review-tiles");
    expect(dry.text()).toContain("would write 1 column(s) to the federation record");

    await adoptFederationStorage({ slug: "neogranadina", target: "production", values: VALUES, apply: true }, providers, () => {});
    expect(world.b2.keys.slice(2).map((k) => k.name)).toEqual(["fisqua-neogranadina-review-tiles-fisqua-share"]);
    expect(world.cf.tokens).toHaveLength(1);
    expect(world.d1.federations[0]).toMatchObject({ ...VALUES, pipeline_review_tiles_bucket: "neogranadina-review-tiles" });
    expect([...world.worker.entries()].filter(([, v]) => v === "held")).toHaveLength(6);
    expect(world.worker.size).toBe(8);

    // On staging it is named for staging.
    const staging = fakeWorld({ federation: "neogranadina", tenant: "neogranadina" });
    staging.world.b2.buckets.set("existing-iiif-tiles", { bucketId: "b-t", bucketName: "existing-iiif-tiles", bucketType: "allPublic", corsRules: [] });
    staging.world.b2.buckets.set("existing-masters", { bucketId: "b-m", bucketName: "existing-masters", bucketType: "allPrivate", corsRules: [] });
    staging.world.cf.r2.add("existing-manifests");
    await adoptFederationStorage({ slug: "neogranadina", target: "staging", values: VALUES, apply: true }, staging.providers, () => {});
    expect(staging.world.b2.buckets.get("neogranadina-staging-review-tiles")!.corsRules).toEqual(reviewTilesCorsRules("staging"));
  });

  it("is neither made nor recorded by adoption on the local target", async () => {
    const { world, providers } = fakeWorld({ federation: "neogranadina", tenant: "neogranadina" });
    const VALUES: DestinationValues = {
      pipeline_delivery_endpoint: FAKE_B2_S3,
      pipeline_tiles_bucket: "existing-iiif-tiles",
      pipeline_masters_bucket: "existing-masters",
      pipeline_image_base_url: "https://iiif.existing.example.test",
      manifest_endpoint: FAKE_R2_S3,
      manifest_bucket: "existing-manifests",
      manifest_base_url: "https://manifests.existing.example.test",
      storage_secret_prefix: "FEDERATION_NEOGRANADINA",
    };
    await adoptFederationStorage({ slug: "neogranadina", target: "local", values: VALUES, apply: true }, { ...providers, b2: null, cloudflare: null, worker: null }, () => {});
    expect(world.b2.buckets.has("neogranadina-review-tiles")).toBe(false);
    expect(world.d1.federations[0].pipeline_review_tiles_bucket).toBeNull();
    expect(world.d1.writes).toBe(1);
  });
});

describe("a record without the review-tiles bucket", () => {
  const COMPLETE: DestinationValues = {
    pipeline_delivery_endpoint: "https://e.example.test",
    pipeline_tiles_bucket: "t-bucket",
    pipeline_masters_bucket: "mb-bucket",
    pipeline_image_base_url: "https://i.example.test",
    manifest_endpoint: "https://r.example.test",
    manifest_bucket: "m-bucket",
    manifest_base_url: "https://mm.example.test",
    storage_secret_prefix: "PX",
  };

  it("is complete, and an UPDATE without the column leaves it as recorded", () => {
    const row = { ...emptyFederation("f", "f"), ...COMPLETE, pipeline_review_tiles_bucket: null };
    expect(isRecordComplete(row)).toBe(true);
    expect(missingRecordColumns(row)).toEqual([]);
    expect(isRecordComplete({ ...row, pipeline_review_tiles_bucket: "r-bucket" })).toBe(true);
    expect(missingRecordColumns({ ...row, pipeline_masters_bucket: null })).toEqual(["pipeline_masters_bucket"]);
    expect(destinationStatement("id-1", COMPLETE)).not.toContain("pipeline_review_tiles_bucket");
    expect(destinationStatement("id-1", { ...COMPLETE, pipeline_review_tiles_bucket: "r-bucket" })).toMatch(
      /storage_secret_prefix = 'PX', pipeline_review_tiles_bucket = 'r-bucket' WHERE id = 'id-1';$/,
    );
    expect(destinationStatement("id-1", { ...COMPLETE, pipeline_review_tiles_bucket: null })).toMatch(
      /pipeline_review_tiles_bucket = NULL WHERE id = 'id-1';$/,
    );
  });

  it("refuses a review-tiles bucket name of the wrong form", () => {
    expect(() => checkDestinationValues({ ...COMPLETE, pipeline_review_tiles_bucket: "Bad_Bucket" })).toThrow(
      /pipeline_review_tiles_bucket is not a bucket name/,
    );
    expect(() => checkDestinationValues({ ...COMPLETE, pipeline_review_tiles_bucket: null })).not.toThrow();
  });
});

describe("bucket names across roles", () => {
  it("stops when the masters bucket given is the review-tiles bucket's name, before anything is touched", async () => {
    for (const apply of [false, true]) {
      const { world, providers } = fakeWorld();
      world.b2.buckets.set("acme-review-tiles", { bucketId: "b-r", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [] });
      expect(await stopped(provisionFederationStorage({ ...OPTS, mastersBucket: "acme-review-tiles", apply }, providers, () => {}))).toBe(
        "The masters bucket and the review-tiles bucket would both be acme-review-tiles; each role needs its own bucket",
      );
      expect(world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
      expect(world.b2.keys).toEqual([]);
      expect(world.worker.size).toBe(0);
      expect(world.d1.writes).toBe(0);
    }
  });

  it("stops when a planned bucket is the shared working bucket", async () => {
    const { world, providers } = fakeWorld();
    expect(
      await stopped(provisionFederationStorage({ ...OPTS, mastersBucket: "fisqua-pipeline-working", apply: false }, providers, () => {})),
    ).toBe("The masters bucket and the shared working bucket would both be fisqua-pipeline-working; each role needs its own bucket");
    expect(world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
  });

  it("stops when another federation records the name in another role", async () => {
    const cases: Array<[keyof DestinationValues, string, string]> = [
      ["pipeline_masters_bucket", "acme-review-tiles", "Federation other records acme-review-tiles as its masters bucket; it cannot also be this federation's review-tiles bucket"],
      ["pipeline_review_tiles_bucket", "acme-masters", "Federation other records acme-masters as its review-tiles bucket; it cannot also be this federation's masters bucket"],
      ["pipeline_tiles_bucket", "acme-review-tiles", "Federation other records acme-review-tiles as its tiles bucket; it cannot also be this federation's review-tiles bucket"],
      ["manifest_bucket", "acme-iiif-tiles", "Federation other records acme-iiif-tiles as its manifest bucket; it cannot also be this federation's tiles bucket"],
    ];
    for (const [column, value, message] of cases) {
      for (const apply of [false, true]) {
        const { world, providers } = fakeWorld();
        world.d1.federations.push({ ...emptyFederation("other", "other"), [column]: value });
        expect(await stopped(provisionFederationStorage({ ...OPTS, apply }, providers, () => {}))).toBe(message);
        expect(world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
      }
    }
  });

  it("stops adoption when the masters bucket given is the review-tiles bucket's name, or another federation's in another role", async () => {
    const VALUES: DestinationValues = {
      pipeline_delivery_endpoint: FAKE_B2_S3,
      pipeline_tiles_bucket: "existing-iiif-tiles",
      pipeline_masters_bucket: "neogranadina-review-tiles",
      pipeline_image_base_url: "https://iiif.existing.example.test",
      manifest_endpoint: FAKE_R2_S3,
      manifest_bucket: "existing-manifests",
      manifest_base_url: "https://manifests.existing.example.test",
      storage_secret_prefix: "FEDERATION_NEOGRANADINA",
    };
    const a = fakeWorld({ federation: "neogranadina", tenant: "neogranadina" });
    expect(await stopped(adoptFederationStorage({ slug: "neogranadina", target: "production", values: VALUES, apply: true }, a.providers, () => {}))).toBe(
      "The masters bucket and the review-tiles bucket would both be neogranadina-review-tiles; each role needs its own bucket",
    );
    expect(a.world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);

    const b = fakeWorld({ federation: "neogranadina", tenant: "neogranadina" });
    b.world.d1.federations.push({ ...emptyFederation("other", "other"), pipeline_masters_bucket: "neogranadina-review-tiles" });
    expect(
      await stopped(
        adoptFederationStorage(
          { slug: "neogranadina", target: "production", values: { ...VALUES, pipeline_masters_bucket: "existing-masters" }, apply: false },
          b.providers,
          () => {},
        ),
      ),
    ).toBe("Federation other records neogranadina-review-tiles as its masters bucket; it cannot also be this federation's review-tiles bucket");
    expect(b.world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
  });
});

describe("an existing review-tiles bucket with lifecycle rules", () => {
  const RULES = [{ fileNamePrefix: "", daysFromUploadingToHiding: 1, daysFromHidingToDeleting: 1 }];
  const expected =
    `The B2 bucket acme-review-tiles has lifecycle rules (${JSON.stringify(RULES)}), which could delete review tiles ` +
    "before Fisqua does; the command does not adopt it or clear them. Remove them by hand and run the command again";

  it("stops provisioning, dry run and apply, naming the rules, before anything is created", async () => {
    for (const apply of [false, true]) {
      const { world, providers } = fakeWorld();
      world.b2.buckets.set("acme-review-tiles", {
        bucketId: "b-r", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [], lifecycleRules: RULES,
      });
      expect(await stopped(provisionFederationStorage({ ...OPTS, apply }, providers, () => {}))).toBe(expected);
      expect(world.calls.filter((c) => c.startsWith("b2.createBucket") || c === "b2.updateBucket")).toEqual([]);
      expect(world.b2.keys).toEqual([]);
      expect(world.b2.buckets.get("acme-review-tiles")!.lifecycleRules).toEqual(RULES);
      expect(world.d1.writes).toBe(0);
    }
  });

  it("stops adoption the same way, leaving the rules in place", async () => {
    const VALUES: DestinationValues = {
      pipeline_delivery_endpoint: FAKE_B2_S3,
      pipeline_tiles_bucket: "existing-iiif-tiles",
      pipeline_masters_bucket: "existing-masters",
      pipeline_image_base_url: "https://iiif.existing.example.test",
      manifest_endpoint: FAKE_R2_S3,
      manifest_bucket: "existing-manifests",
      manifest_base_url: "https://manifests.existing.example.test",
      storage_secret_prefix: "FEDERATION_NEOGRANADINA",
    };
    for (const apply of [false, true]) {
      const { world, providers } = fakeWorld({ federation: "neogranadina", tenant: "neogranadina" });
      world.b2.buckets.set("existing-iiif-tiles", { bucketId: "b-t", bucketName: "existing-iiif-tiles", bucketType: "allPublic", corsRules: [] });
      world.b2.buckets.set("existing-masters", { bucketId: "b-m", bucketName: "existing-masters", bucketType: "allPrivate", corsRules: [] });
      world.b2.buckets.set("neogranadina-review-tiles", {
        bucketId: "b-r", bucketName: "neogranadina-review-tiles", bucketType: "allPrivate", corsRules: [], lifecycleRules: RULES,
      });
      world.cf.r2.add("existing-manifests");
      expect(await stopped(adoptFederationStorage({ slug: "neogranadina", target: "production", values: VALUES, apply }, providers, () => {}))).toBe(
        expected.replace("acme-review-tiles", "neogranadina-review-tiles"),
      );
      expect(world.calls).not.toContain("b2.updateBucket");
      expect(world.b2.keys).toEqual([]);
      expect(world.d1.writes).toBe(0);
    }
  });

  it("adopts a bucket whose lifecycle rule list is empty", async () => {
    const { world, providers } = fakeWorld();
    world.b2.buckets.set("acme-review-tiles", {
      bucketId: "b-r", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [...reviewTilesCorsRules("production")], lifecycleRules: [],
    });
    const out = capture();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, out.log);
    expect(out.text()).toContain("[update] B2 bucket acme-review-tiles: tagged as the production review-tiles bucket of federation acme");
    expect(world.d1.federations[0].pipeline_review_tiles_bucket).toBe("acme-review-tiles");
  });
});

describe("bucket names against the federation's own record", () => {
  const PLANNED = {
    pipeline_tiles_bucket: ["acme-iiif-tiles", "tiles bucket"],
    pipeline_masters_bucket: ["acme-masters", "masters bucket"],
    pipeline_review_tiles_bucket: ["acme-review-tiles", "review-tiles bucket"],
    manifest_bucket: ["acme-manifests", "manifest bucket"],
  } as const;
  type Column = keyof typeof PLANNED;
  const COLUMNS = Object.keys(PLANNED) as Column[];

  it("stops when the record's masters bucket would become the review-tiles bucket, with nothing created", async () => {
    for (const apply of [false, true]) {
      const { world, providers } = fakeWorld();
      // The federation records acme-review-tiles as its masters bucket, holding a master.
      Object.assign(world.d1.federations[0], {
        pipeline_delivery_endpoint: FAKE_B2_S3,
        pipeline_tiles_bucket: "acme-iiif-tiles",
        pipeline_masters_bucket: "acme-review-tiles",
        pipeline_image_base_url: "https://iiif.acme.example.test",
        manifest_endpoint: FAKE_R2_S3,
        manifest_bucket: "acme-manifests",
        manifest_base_url: "https://manifests.acme.example.test",
        storage_secret_prefix: "FEDERATION_ACME",
      });
      world.b2.buckets.set("acme-review-tiles", { bucketId: "b-masters", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [] });
      world.b2.files.set("b-masters", [{ fileName: "sbmal/private-master.cr2", contentLength: 10 }]);
      // Without --masters-bucket the recorded masters bucket is kept, so the
      // two roles meet in the planned names.
      expect(await stopped(provisionFederationStorage({ ...OPTS, apply }, providers, () => {}))).toBe(
        "The masters bucket and the review-tiles bucket would both be acme-review-tiles; each role needs its own bucket",
      );
      // With the flag naming a new masters bucket, the recorded role still stops it.
      expect(
        await stopped(provisionFederationStorage({ ...OPTS, mastersBucket: "acme-masters", apply }, providers, () => {})),
      ).toBe("Federation acme records acme-review-tiles as its masters bucket; it cannot also be its review-tiles bucket");
      // Only reads: the record and, for a complete record, the B2 account's endpoint.
      expect(world.calls.filter((c) => !c.startsWith("d1.") && c !== "b2.account")).toEqual([]);
      expect(world.b2.buckets.has("acme-masters")).toBe(false);
      expect(world.b2.keys).toEqual([]);
      expect(world.worker.size).toBe(0);
      expect(world.d1.writes).toBe(0);
      expect(world.d1.federations[0].pipeline_masters_bucket).toBe("acme-review-tiles");
    }
  });

  it("stops for every other pairing of a recorded role and a planned role, and for the working bucket", async () => {
    for (const recordedColumn of COLUMNS) {
      for (const plannedColumn of COLUMNS) {
        if (recordedColumn === plannedColumn) continue;
        const [name, plannedRole] = PLANNED[plannedColumn];
        const recordedRole = PLANNED[recordedColumn][1];
        for (const apply of [false, true]) {
          const { world, providers } = fakeWorld();
          Object.assign(world.d1.federations[0], { [recordedColumn]: name });
          // A recorded masters bucket is kept without the flag, so it meets
          // the other role among the planned names, in BUCKET_ROLES order.
          const order = COLUMNS.indexOf(recordedColumn) < COLUMNS.indexOf(plannedColumn);
          const expected =
            recordedColumn === "pipeline_masters_bucket"
              ? `The ${order ? recordedRole : plannedRole} and the ${order ? plannedRole : recordedRole} would both be ${name}; each role needs its own bucket`
              : `Federation acme records ${name} as its ${recordedRole}; it cannot also be its ${plannedRole}`;
          expect(await stopped(provisionFederationStorage({ ...OPTS, apply }, providers, () => {})), `${recordedColumn} ${plannedColumn}`).toBe(
            expected,
          );
          expect(world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
        }
      }
    }
    // A recorded bucket that is the target's working bucket.
    const { world, providers } = fakeWorld();
    Object.assign(world.d1.federations[0], { pipeline_tiles_bucket: "fisqua-pipeline-working" });
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: false }, providers, () => {}))).toBe(
      "Federation acme records fisqua-pipeline-working as its tiles bucket; it cannot also be its shared working bucket",
    );
  });

  it("goes ahead when the record names the same buckets in the same roles", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    const before = world.calls.length;
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(writeCalls(world.calls.slice(before))).toEqual([]);
  });

  it("stops adoption when the record's masters bucket would become the review-tiles bucket", async () => {
    const VALUES: DestinationValues = {
      pipeline_delivery_endpoint: FAKE_B2_S3,
      pipeline_tiles_bucket: "existing-iiif-tiles",
      pipeline_masters_bucket: "existing-masters",
      pipeline_image_base_url: "https://iiif.existing.example.test",
      manifest_endpoint: FAKE_R2_S3,
      manifest_bucket: "existing-manifests",
      manifest_base_url: "https://manifests.existing.example.test",
      storage_secret_prefix: "FEDERATION_NEOGRANADINA",
    };
    for (const apply of [false, true]) {
      const { world, providers } = fakeWorld({ federation: "neogranadina", tenant: "neogranadina" });
      Object.assign(world.d1.federations[0], { ...VALUES, pipeline_masters_bucket: "neogranadina-review-tiles" });
      expect(await stopped(adoptFederationStorage({ slug: "neogranadina", target: "production", values: VALUES, apply }, providers, () => {}))).toBe(
        "Federation neogranadina records neogranadina-review-tiles as its masters bucket; it cannot also be its review-tiles bucket",
      );
      expect(world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
    }
  });
});

describe("a pre-existing review-tiles bucket that holds files", () => {
  const holdsFiles = (name: string) =>
    `The B2 bucket ${name} holds files and is not tagged as this federation's production review-tiles bucket; ` +
    "the command adopts only an empty bucket as the review-tiles bucket and never deletes files. " +
    "Check what it holds and run the command again once it is empty or another name is used";

  it("stops at a former masters bucket: another federation moved away from it, and nothing is issued over it", async () => {
    const { world, providers } = fakeWorld();
    world.d1.federations.push(emptyFederation("f-bravo", "bravo"));
    world.d1.tenants.push({ id: "22222222-bbbb-4bbb-8bbb-222222222222", slug: "bravotenant", federation_id: "f-bravo" });
    world.cf.zones.set("bravo.example.test", "zone-bravo");
    world.b2.buckets.set("bravo-review-tiles", { bucketId: "b-old-masters", bucketName: "bravo-review-tiles", bucketType: "allPrivate", corsRules: [] });
    world.b2.files.set("b-old-masters", [{ fileName: "sbmal/private-master.cr2", contentLength: 10 }]);
    world.b2.buckets.set("acme-masters-2", { bucketId: "b-new-masters", bucketName: "acme-masters-2", bucketType: "allPrivate", corsRules: [] });

    // 1. acme takes bravo-review-tiles as its masters bucket.
    await provisionFederationStorage({ ...OPTS, mastersBucket: "bravo-review-tiles", apply: true }, providers, () => {});
    expect(world.d1.federations[0].pipeline_masters_bucket).toBe("bravo-review-tiles");
    // 2. acme moves to another masters bucket; the old one keeps its files and loses its recorded role.
    await provisionFederationStorage({ ...OPTS, mastersBucket: "acme-masters-2", apply: true }, providers, () => {});
    expect(world.d1.federations[0].pipeline_masters_bucket).toBe("acme-masters-2");
    expect(world.b2.files.get("b-old-masters")).toHaveLength(1);

    // 3. bravo's review-tiles bucket would be the former masters bucket.
    const BRAVO = { slug: "bravo", domain: "bravo.example.test", target: "production" as const };
    for (const apply of [false, true]) {
      const keysBefore = world.b2.keys.length;
      const before = world.calls.length;
      // Step 1 tagged it as acme's masters bucket, which stops bravo even
      // though no record names it any more.
      expect(await stopped(provisionFederationStorage({ ...BRAVO, apply }, providers, () => {}))).toBe(
        "The B2 bucket bravo-review-tiles is tagged as the masters bucket of federation acme " +
          "(fisqua-role=masters, fisqua-federation=acme); it cannot be the production review-tiles bucket " +
          "of federation bravo. The command never changes a bucket's tags: a bucket changes role only by an operator's action outside it",
      );
      expect(writeCalls(world.calls.slice(before))).toEqual([]);
      expect(world.b2.keys).toHaveLength(keysBefore);
    }
    expect(world.b2.keys.some((k) => k.bucketId === "b-old-masters" && k.name.includes("review-tiles"))).toBe(false);
    expect([...world.worker.keys()].some((n) => n.startsWith("FEDERATION_BRAVO_"))).toBe(false);
    expect(world.b2.buckets.has("bravo-iiif-tiles")).toBe(false);
    expect(world.d1.federations.find((f) => f.slug === "bravo")!.pipeline_review_tiles_bucket).toBeNull();
    // bravo's tenant gets no keys: its federation has no record.
    const keysBefore = world.b2.keys.length;
    expect(
      await stopped(provisionTenantStorage({ slug: "bravotenant", target: "production", workingBucket: FAKE_WORKING_BUCKET, apply: true }, providers, () => {})),
    ).toMatch(/federation bravo has no complete storage record/);
    expect(world.b2.keys).toHaveLength(keysBefore);
    expect(world.b2.files.get("b-old-masters")).toHaveLength(1);
  });

  it("counts hidden and old versions as files", async () => {
    const { world, providers } = fakeWorld();
    world.b2.buckets.set("acme-review-tiles", { bucketId: "b-r", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [] });
    world.b2.files.set("b-r", [{ fileName: "sbmal/gone.cr2", contentLength: 0, action: "hide" }]);
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: false }, providers, () => {}))).toBe(holdsFiles("acme-review-tiles"));
    expect(world.calls).toContain("b2.hasFileVersions");
  });

  it("stops adoption the same way", async () => {
    const VALUES: DestinationValues = {
      pipeline_delivery_endpoint: FAKE_B2_S3,
      pipeline_tiles_bucket: "existing-iiif-tiles",
      pipeline_masters_bucket: "existing-masters",
      pipeline_image_base_url: "https://iiif.existing.example.test",
      manifest_endpoint: FAKE_R2_S3,
      manifest_bucket: "existing-manifests",
      manifest_base_url: "https://manifests.existing.example.test",
      storage_secret_prefix: "FEDERATION_NEOGRANADINA",
    };
    for (const apply of [false, true]) {
      const { world, providers } = fakeWorld({ federation: "neogranadina", tenant: "neogranadina" });
      world.b2.buckets.set("existing-iiif-tiles", { bucketId: "b-t", bucketName: "existing-iiif-tiles", bucketType: "allPublic", corsRules: [] });
      world.b2.buckets.set("existing-masters", { bucketId: "b-m", bucketName: "existing-masters", bucketType: "allPrivate", corsRules: [] });
      world.b2.buckets.set("neogranadina-review-tiles", { bucketId: "b-r", bucketName: "neogranadina-review-tiles", bucketType: "allPrivate", corsRules: [] });
      world.b2.files.set("b-r", [{ fileName: "x/master.cr2", contentLength: 1 }]);
      world.cf.r2.add("existing-manifests");
      expect(await stopped(adoptFederationStorage({ slug: "neogranadina", target: "production", values: VALUES, apply }, providers, () => {}))).toBe(
        holdsFiles("neogranadina-review-tiles"),
      );
      expect(writeCalls(world.calls)).toEqual([]);
      expect(world.b2.keys).toEqual([]);
    }
  });

  it("adopts an empty pre-existing bucket", async () => {
    const { world, providers } = fakeWorld();
    world.b2.buckets.set("acme-review-tiles", { bucketId: "b-r", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [] });
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.calls).toContain("b2.hasFileVersions");
    expect(world.calls).not.toContain("b2.createBucket:acme-review-tiles");
    expect(world.b2.keys.find((k) => k.name === "fisqua-acme-review-tiles-fisqua-share")!.bucketId).toBe("b-r");
    expect(world.d1.federations[0].pipeline_review_tiles_bucket).toBe("acme-review-tiles");
  });

  it("goes ahead on a rerun over the federation's own recorded review-tiles bucket with tiles in it", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    const id = world.b2.buckets.get("acme-review-tiles")!.bucketId;
    world.b2.files.set(id, [{ fileName: "sbmal/d-1/co-1-img_0001_c0/info.json", contentLength: 100 }]);
    const out = capture();
    const before = world.calls.length;
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, out.log);
    expect(writeCalls(world.calls.slice(before))).toEqual([]);
    expect(out.text()).toContain("already holds this destination");
    expect(world.b2.files.get(id)).toHaveLength(1);
  });
});

describe("changing the recorded masters bucket", () => {
  const SHARED = "shared-masters";
  function recordedShared() {
    const w = fakeWorld();
    w.world.b2.buckets.set(SHARED, { bucketId: "bucket-shared", bucketName: SHARED, bucketType: "allPrivate", corsRules: [] });
    w.world.b2.buckets.set("other-masters", { bucketId: "bucket-other-masters", bucketName: "other-masters", bucketType: "allPrivate", corsRules: [] });
    return w;
  }

  it("keeps the recorded masters bucket without the flag, and a rerun creates nothing", async () => {
    const { world, providers } = recordedShared();
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED, apply: true }, providers, () => {});
    const keysBefore = world.b2.keys.length;
    world.d1.openRuns = 1;
    const dry = capture();
    const before = world.calls.length;
    await provisionFederationStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain("masters bucket (B2, private): shared-masters (recorded, kept; --masters-bucket changes it)");
    expect(dry.text()).toContain("[exists] B2 bucket shared-masters, private (recorded, kept)");
    expect(dry.text()).not.toMatch(/acme-masters(?!-list)/);
    expect(dry.text()).toContain("pipeline_masters_bucket: unchanged");
    expect(dry.text()).not.toContain("[reissue]");
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(writeCalls(world.calls.slice(before))).toEqual([]);
    expect(world.b2.buckets.has("acme-masters")).toBe(false);
    expect(world.b2.keys).toHaveLength(keysBefore);
    expect(world.d1.federations[0].pipeline_masters_bucket).toBe(SHARED);
  });

  it("stops without the flag when the recorded masters bucket is missing or not private", async () => {
    const { world, providers } = recordedShared();
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED, apply: true }, providers, () => {});
    world.b2.buckets.delete(SHARED);
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: false }, providers, () => {}))).toBe(
      "The masters bucket shared-masters is not in the B2 account; it is the recorded one, kept, not created",
    );
  });

  it("is a no-op with the flag naming the recorded bucket", async () => {
    const { world, providers } = recordedShared();
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED, apply: true }, providers, () => {});
    world.d1.openRuns = 1;
    const before = world.calls.length;
    const out = capture();
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED, apply: true }, providers, out.log);
    expect(writeCalls(world.calls.slice(before))).toEqual([]);
    expect(out.text()).toContain("already holds this destination");
  });

  it("replaces it under the existing rules with the flag naming another bucket", async () => {
    const { world, providers } = recordedShared();
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED, apply: true }, providers, () => {});
    world.d1.openRuns = 1;
    expect(await stopped(provisionFederationStorage({ ...OPTS, mastersBucket: "other-masters", apply: true }, providers, () => {}))).toMatch(
      /1 open run/,
    );
    world.d1.openRuns = 0;
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, mastersBucket: "other-masters", apply: false }, providers, dry.log);
    expect(dry.text()).toContain("[reissue] would issue fisqua-acme-masters-list again");
    expect(dry.text()).toContain("the older key fisqua-acme-masters-list is left in place, to be deleted by hand");
    expect(dry.text()).toContain("[note] the runner keys of sbmal are limited to the old masters bucket");
    await provisionFederationStorage({ ...OPTS, mastersBucket: "other-masters", apply: true }, providers, () => {});
    expect(world.d1.federations[0].pipeline_masters_bucket).toBe("other-masters");
    expect(world.b2.keys.filter((k) => k.name === "fisqua-acme-masters-list").map((k) => k.bucketId)).toEqual([
      "bucket-shared",
      "bucket-other-masters",
    ]);
  });
});

describe("bucket role tags in B2, which every environment sees", () => {
  const tag = (role: string, env: string, federation?: string) => ({
    "fisqua-role": role,
    "fisqua-env": env,
    ...(federation ? { "fisqua-federation": federation } : {}),
  });

  it("stops production at a staging review-tiles bucket given as masters, with nothing created", async () => {
    const { world, providers } = fakeWorld();
    // 1. Staging provisions acme and its tenant, with review keys over acme-staging-review-tiles.
    await provisionFederationStorage({ ...STAGING, apply: true }, providers, () => {});
    world.b2.buckets.set("fisqua-pipeline-working-staging", {
      bucketId: "bucket-working-staging", bucketName: "fisqua-pipeline-working-staging", bucketType: "allPrivate", corsRules: [],
      bucketInfo: { "fisqua-role": "working", "fisqua-env": "staging" },
    });
    await provisionTenantStorage(
      { slug: "sbmal", target: "staging", workingBucket: "fisqua-pipeline-working-staging", apply: true },
      providers,
      () => {},
    );
    const review = world.b2.buckets.get("acme-staging-review-tiles")!;
    expect(world.b2.keys.filter((k) => k.bucketId === review.bucketId).map((k) => k.name)).toContain(
      "fisqua-sbmal-staging-review-tiles-runner-delete",
    );
    // Production's database cannot see staging's record.
    world.d1.federations[0] = emptyFederation(world.d1.federations[0].id, "acme");
    const buckets = new Map([...world.b2.buckets].map(([k, v]) => [k, structuredClone(v)]));
    const keys = world.b2.keys.length;

    // 2. Production takes that bucket as its masters bucket.
    for (const apply of [false, true]) {
      const before = world.calls.length;
      expect(await stopped(provisionFederationStorage({ ...OPTS, mastersBucket: "acme-staging-review-tiles", apply }, providers, () => {}))).toBe(
        "The B2 bucket acme-staging-review-tiles is tagged as the staging review-tiles bucket of federation acme " +
          "(fisqua-role=review-tiles, fisqua-env=staging, fisqua-federation=acme); it cannot be the masters bucket " +
          "of federation acme. The command never changes a bucket's tags: a bucket changes role only by an operator's action outside it",
      );
      expect(writeCalls(world.calls.slice(before))).toEqual([]);
    }
    expect(world.b2.buckets).toEqual(buckets);
    expect(world.b2.keys).toHaveLength(keys);
    expect(world.d1.writes).toBe(1);
  });

  it("lets a staging run and then a production run share a masters bucket, which gains no environment tag", async () => {
    const { world, providers } = fakeWorld();
    world.b2.buckets.set(SHARED_MASTERS, {
      bucketId: "b-m", bucketName: SHARED_MASTERS, bucketType: "allPrivate", corsRules: [], bucketInfo: { owner: "lab" },
    });
    world.b2.buckets.set("fisqua-pipeline-working-staging", {
      bucketId: "bucket-working-staging", bucketName: "fisqua-pipeline-working-staging", bucketType: "allPrivate", corsRules: [],
      bucketInfo: { "fisqua-role": "working", "fisqua-env": "staging" },
    });
    world.b2.buckets.get(FAKE_WORKING_BUCKET)!.bucketInfo = { "fisqua-role": "working", "fisqua-env": "production" };
    const shared = { owner: "lab", "fisqua-role": "masters", "fisqua-federation": "acme" };

    // 1. Staging takes the bucket as its masters bucket, and its tenant follows.
    const stagingDry = capture();
    await provisionFederationStorage({ ...STAGING, mastersBucket: SHARED_MASTERS, apply: false }, providers, stagingDry.log);
    expect(stagingDry.text()).toContain("[update] B2 bucket shared-masters: would be tagged as the masters bucket of federation acme");
    await provisionFederationStorage({ ...STAGING, mastersBucket: SHARED_MASTERS, apply: true }, providers, () => {});
    expect(world.b2.buckets.get(SHARED_MASTERS)!.bucketInfo).toEqual(shared);
    await provisionTenantStorage(
      { slug: "sbmal", target: "staging", workingBucket: "fisqua-pipeline-working-staging", apply: true },
      providers,
      () => {},
    );

    // 2. Production's database cannot see staging's record; it takes the same bucket.
    world.d1.federations[0] = emptyFederation(world.d1.federations[0].id, "acme");
    const revision = world.b2.buckets.get(SHARED_MASTERS)!.revision;
    const productionDry = capture();
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED_MASTERS, apply: false }, providers, productionDry.log);
    expect(productionDry.text()).not.toContain("B2 bucket shared-masters: would be tagged");
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED_MASTERS, apply: true }, providers, () => {});
    await provisionTenantStorage({ slug: "sbmal", target: "production", workingBucket: FAKE_WORKING_BUCKET, apply: true }, providers, () => {});
    expect(world.d1.federations[0].pipeline_masters_bucket).toBe(SHARED_MASTERS);

    // The bucket was tagged once, by staging, and carries no environment.
    const bucket = world.b2.buckets.get(SHARED_MASTERS)!;
    expect(bucket.bucketInfo).toEqual(shared);
    expect(bucket.revision).toBe(revision);
    const overBucket = world.b2.keys.filter((k) => k.bucketId === "b-m").map((k) => k.name);
    expect(overBucket).toEqual(expect.arrayContaining(["fisqua-acme-staging-masters-list", "fisqua-acme-masters-list"]));
    expect(overBucket.some((n) => n.startsWith("fisqua-sbmal-staging-"))).toBe(true);
    expect(overBucket.some((n) => n.startsWith("fisqua-sbmal-") && !n.startsWith("fisqua-sbmal-staging-"))).toBe(true);
  });

  it("accepts a masters bucket tagged for production when staging uses it, and leaves the tag unchanged", async () => {
    const { world, providers } = fakeWorld();
    const info = { owner: "lab", "fisqua-role": "masters", "fisqua-env": "production", "fisqua-federation": "acme" };
    world.b2.buckets.set(SHARED_MASTERS, {
      bucketId: "b-m", bucketName: SHARED_MASTERS, bucketType: "allPrivate", corsRules: [], bucketInfo: { ...info }, revision: 1,
    });
    const dry = capture();
    await provisionFederationStorage({ ...STAGING, mastersBucket: SHARED_MASTERS, apply: false }, providers, dry.log);
    expect(dry.text()).not.toContain("B2 bucket shared-masters: would be tagged");
    await provisionFederationStorage({ ...STAGING, mastersBucket: SHARED_MASTERS, apply: true }, providers, () => {});
    expect(world.b2.buckets.get(SHARED_MASTERS)).toMatchObject({ bucketInfo: info, revision: 1 });
    expect(world.d1.federations[0].pipeline_masters_bucket).toBe(SHARED_MASTERS);
    expect(world.b2.keys.filter((k) => k.bucketId === "b-m").map((k) => k.name)).toEqual(["fisqua-acme-staging-masters-list"]);
  });

  it("refuses a masters bucket tagged for another federation or another role, in either environment", async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ "fisqua-role": "masters", "fisqua-federation": "bravo" }, /tagged as the masters bucket of federation bravo .*; it cannot be the masters bucket of federation acme/],
      [tag("masters", "staging", "bravo"), /tagged as the staging masters bucket of federation bravo .*; it cannot be the masters bucket of federation acme/],
      [tag("tiles", "production", "acme"), /tagged as the production tiles bucket of federation acme .*; it cannot be the masters bucket of federation acme/],
      [tag("tiles", "staging", "acme"), /tagged as the staging tiles bucket of federation acme .*; it cannot be the masters bucket of federation acme/],
    ];
    for (const [info, message] of cases) {
      for (const target of ["staging", "production"] as const) {
        for (const apply of [false, true]) {
          const { world, providers } = fakeWorld();
          world.b2.buckets.set(SHARED_MASTERS, {
            bucketId: "b-m", bucketName: SHARED_MASTERS, bucketType: "allPrivate", corsRules: [], bucketInfo: { ...info },
          });
          expect(await stopped(provisionFederationStorage({ ...OPTS, target, mastersBucket: SHARED_MASTERS, apply }, providers, () => {}))).toMatch(message);
          expect(writeCalls(world.calls)).toEqual([]);
          expect(world.b2.buckets.get(SHARED_MASTERS)!.bucketInfo).toEqual(info);
          expect(world.b2.keys).toEqual([]);
        }
      }
    }
  });

  it("still refuses a tiles bucket tagged for the other environment", async () => {
    for (const [target, name, env] of [
      ["production", "acme-iiif-tiles", "staging"],
      ["staging", "acme-staging-iiif-tiles", "production"],
    ] as const) {
      for (const apply of [false, true]) {
        const { world, providers } = fakeWorld();
        world.b2.buckets.set(name, {
          bucketId: "b-t", bucketName: name, bucketType: "allPublic", corsRules: [...B2_CORS_RULES], bucketInfo: tag("tiles", env, "acme"),
        });
        expect(await stopped(provisionFederationStorage({ ...OPTS, target, apply }, providers, () => {}))).toMatch(
          new RegExp(`${name} is tagged as the ${env} tiles bucket of federation acme .*; it cannot be the ${target} tiles bucket of federation acme`),
        );
        expect(writeCalls(world.calls)).toEqual([]);
        expect(world.b2.keys).toEqual([]);
      }
    }
  });

  it("refuses a tagged bucket's role conflict in the dry run, before anything is created", async () => {
    const { world, providers } = fakeWorld();
    world.b2.buckets.set("acme-iiif-tiles", {
      bucketId: "b-t", bucketName: "acme-iiif-tiles", bucketType: "allPublic", corsRules: [], bucketInfo: tag("masters", "production", "acme"),
    });
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: false }, providers, () => {}))).toMatch(
      /acme-iiif-tiles is tagged as the production masters bucket of federation acme .*; it cannot be the production tiles bucket/,
    );
    expect(writeCalls(world.calls)).toEqual([]);
    expect(world.b2.buckets.get("acme-iiif-tiles")!.bucketInfo).toEqual(tag("masters", "production", "acme"));
  });

  it("tags an untagged masters bucket on a rerun, keeping its other bucket info, and then changes nothing", async () => {
    const { world, providers } = fakeWorld();
    world.b2.buckets.set(SHARED_MASTERS, {
      bucketId: "b-m", bucketName: SHARED_MASTERS, bucketType: "allPrivate", corsRules: [], bucketInfo: { owner: "lab" },
    });
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED_MASTERS, apply: true }, providers, () => {});
    // As for a masters bucket set up before tags: remove the tag, keep the record.
    world.b2.buckets.get(SHARED_MASTERS)!.bucketInfo = { owner: "lab" };
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain("[update] B2 bucket shared-masters: would be tagged as the masters bucket of federation acme");
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.b2.buckets.get(SHARED_MASTERS)!.bucketInfo).toEqual({ owner: "lab", "fisqua-role": "masters", "fisqua-federation": "acme" });
    const before = world.calls.length;
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(writeCalls(world.calls.slice(before))).toEqual([]);
  });

  it("keeps the tags and other bucket info when the CORS rules are set", async () => {
    const { world, providers } = fakeWorld();
    world.b2.buckets.set("acme-review-tiles", {
      bucketId: "b-r", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [...B2_CORS_RULES],
      bucketInfo: { owner: "lab", ...tag("review-tiles", "production", "acme") },
    });
    world.b2.buckets.set("acme-iiif-tiles", {
      bucketId: "b-t", bucketName: "acme-iiif-tiles", bucketType: "allPublic", corsRules: [], bucketInfo: { owner: "lab" },
    });
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.b2.buckets.get("acme-review-tiles")).toMatchObject({
      corsRules: reviewTilesCorsRules("production"),
      bucketInfo: { owner: "lab", ...tag("review-tiles", "production", "acme") },
    });
    // An untagged bucket whose CORS rules change gains its tag in the same update, with its other info kept.
    expect(world.b2.buckets.get("acme-iiif-tiles")).toMatchObject({
      corsRules: B2_CORS_RULES,
      bucketInfo: { owner: "lab", ...tag("tiles", "production", "acme") },
    });
  });

  it("adopts a review-tiles bucket with files when it carries this federation's review-tiles tag", async () => {
    const { world, providers } = fakeWorld();
    world.b2.buckets.set("acme-review-tiles", {
      bucketId: "b-r", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [...reviewTilesCorsRules("production")],
      bucketInfo: tag("review-tiles", "production", "acme"),
    });
    world.b2.files.set("b-r", [{ fileName: "sbmal/d-1/p/info.json", contentLength: 1 }]);
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.d1.federations[0].pipeline_review_tiles_bucket).toBe("acme-review-tiles");
  });
});

describe("tag writes at a revision, and tags confirmed before keys", () => {
  it("fails the second writer with a conflict when another run tags the bucket in between", async () => {
    let paused = false;
    let staging: Promise<void> | null = null;
    const w = fakeWorld({
      // Production pauses just before its tag update on the bucket; staging
      // provisions its federation and tenant meanwhile.
      beforeUpdateBucket: async (bucketId) => {
        if (paused || bucketId !== "b-shared-review") return;
        paused = true;
        staging = (async () => {
          // Staging's database is not production's: its locks are its own.
          const productionLocks = new Map(w.world.d1.locks);
          w.world.d1.locks.clear();
          await provisionFederationStorage({ ...STAGING, apply: true }, w.providers, () => {});
          await provisionTenantStorage(
            { slug: "sbmal", target: "staging", workingBucket: "fisqua-pipeline-working-staging", apply: true },
            w.providers,
            () => {},
          );
          for (const [k, v] of productionLocks) w.world.d1.locks.set(k, v);
        })();
        await staging;
      },
    });
    const { world, providers } = w;
    world.b2.buckets.set("acme-staging-review-tiles", {
      bucketId: "b-shared-review", bucketName: "acme-staging-review-tiles", bucketType: "allPrivate", corsRules: [],
    });
    world.b2.buckets.set("fisqua-pipeline-working-staging", {
      bucketId: "bucket-working-staging", bucketName: "fisqua-pipeline-working-staging", bucketType: "allPrivate", corsRules: [],
      bucketInfo: { "fisqua-role": "working", "fisqua-env": "staging" },
    });

    const message = await stopped(provisionFederationStorage({ ...OPTS, mastersBucket: "acme-staging-review-tiles", apply: true }, providers, () => {}));
    expect(paused).toBe(true);
    expect(world.calls).toContain("b2.updateBucket:conflict");
    expect(message).toBe(
      "The B2 bucket acme-staging-review-tiles is tagged as the staging review-tiles bucket of federation acme " +
        "(fisqua-role=review-tiles, fisqua-env=staging, fisqua-federation=acme); it cannot be the masters bucket " +
        "of federation acme. The command never changes a bucket's tags: a bucket changes role only by an operator's action outside it",
    );
    // Staging's tag stands, and every key over the bucket is a staging review key.
    expect(world.b2.buckets.get("acme-staging-review-tiles")!.bucketInfo).toEqual({
      "fisqua-role": "review-tiles", "fisqua-env": "staging", "fisqua-federation": "acme",
    });
    const overBucket = world.b2.keys.filter((k) => k.bucketId === "b-shared-review").map((k) => k.name).sort();
    expect(overBucket).toEqual([
      "fisqua-acme-staging-review-tiles-fisqua-share",
      "fisqua-sbmal-staging-review-tiles-runner-delete",
      "fisqua-sbmal-staging-review-tiles-runner-write",
    ]);
    expect(world.b2.keys.some((k) => k.name.startsWith("fisqua-acme-") && !k.name.startsWith("fisqua-acme-staging-"))).toBe(false);
  });

  it("re-reads and checks again after a refused write, and goes ahead when the change was harmless", async () => {
    let bumped = false;
    const w = fakeWorld({
      beforeUpdateBucket: (bucketId) => {
        if (bumped || bucketId !== "b-m") return;
        bumped = true;
        // Another writer changes something else on the bucket in between.
        const b = w.world.b2.buckets.get(SHARED_MASTERS)!;
        b.bucketInfo = { owner: "lab" };
        b.revision = (b.revision ?? 1) + 1;
      },
    });
    w.world.b2.buckets.set(SHARED_MASTERS, { bucketId: "b-m", bucketName: SHARED_MASTERS, bucketType: "allPrivate", corsRules: [] });
    await provisionFederationStorage({ ...OPTS, mastersBucket: SHARED_MASTERS, apply: true }, w.providers, () => {});
    expect(w.world.calls.filter((c) => c === "b2.updateBucket:conflict")).toHaveLength(1);
    expect(w.world.b2.buckets.get(SHARED_MASTERS)!.bucketInfo).toEqual({
      owner: "lab", "fisqua-role": "masters", "fisqua-federation": "acme",
    });
  });

  it("issues no key over a bucket whose tag changed after the checks", async () => {
    const { world, providers } = fakeWorld();
    // The tag of the tiles bucket changes after step 1 read it, before Fisqua's key is issued.
    const put = providers.cloudflare!.putTransformRules;
    providers.cloudflare!.putTransformRules = async (zone, rules) => {
      await put(zone, rules);
      world.b2.buckets.get("acme-iiif-tiles")!.bucketInfo = { "fisqua-role": "masters", "fisqua-env": "staging", "fisqua-federation": "acme" };
    };
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}))).toMatch(
      /The B2 bucket acme-iiif-tiles is not tagged as the production tiles bucket of federation acme .*no key is issued over it/,
    );
    expect(world.b2.keys).toEqual([]);
    expect(world.d1.writes).toBe(0);
  });
});

describe("a masters bucket the record moves away from", () => {
  it("is tagged as masters, so a later run cannot take it as the working bucket", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    // As a legacy masters bucket set up before tags.
    world.b2.buckets.get("acme-masters")!.bucketInfo = undefined;
    world.b2.buckets.set("replacement-masters", { bucketId: "b-repl", bucketName: "replacement-masters", bucketType: "allPrivate", corsRules: [] });
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, mastersBucket: "replacement-masters", apply: false }, providers, dry.log);
    expect(dry.text()).toContain("[update] B2 bucket acme-masters: would be tagged as the masters bucket of federation acme");
    const out = capture();
    await provisionFederationStorage({ ...OPTS, mastersBucket: "replacement-masters", apply: true }, providers, out.log);
    expect(out.text()).toContain("[note] the masters bucket acme-masters the record moves away from keeps its masters tag");
    expect(world.b2.buckets.get("acme-masters")!.bucketInfo).toEqual({
      "fisqua-role": "masters", "fisqua-federation": "acme",
    });
    expect(world.d1.federations[0].pipeline_masters_bucket).toBe("replacement-masters");

    // The tenant step with the retired bucket as its working bucket is refused, with nothing issued.
    world.b2.buckets.get(FAKE_WORKING_BUCKET)!.bucketInfo = { "fisqua-role": "working", "fisqua-env": "production" };
    const keys = world.b2.keys.length;
    expect(
      await stopped(provisionTenantStorage({ slug: "sbmal", target: "production", workingBucket: "acme-masters", apply: true }, providers, () => {})),
    ).toMatch(/acme-masters is tagged as the masters bucket of federation acme .*; it cannot be the production working bucket/);
    expect(world.b2.keys).toHaveLength(keys);
    expect(world.gh.environments.size).toBe(0);
  });

  it("is reported and skipped when it is no longer in the account, and refused when tagged for another role", async () => {
    const a = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, a.providers, () => {});
    a.world.b2.buckets.delete("acme-masters");
    a.world.b2.buckets.set("replacement-masters", { bucketId: "b-repl", bucketName: "replacement-masters", bucketType: "allPrivate", corsRules: [] });
    const out = capture();
    await provisionFederationStorage({ ...OPTS, mastersBucket: "replacement-masters", apply: true }, a.providers, out.log);
    expect(out.text()).toContain("[note] the masters bucket acme-masters the record moves away from is not in the B2 account; it is not tagged");
    expect(a.world.d1.federations[0].pipeline_masters_bucket).toBe("replacement-masters");

    const b = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, b.providers, () => {});
    b.world.b2.buckets.get("acme-masters")!.bucketInfo = { "fisqua-role": "tiles", "fisqua-env": "production", "fisqua-federation": "acme" };
    b.world.b2.buckets.set("replacement-masters", { bucketId: "b-repl", bucketName: "replacement-masters", bucketType: "allPrivate", corsRules: [] });
    const before = b.world.calls.length;
    expect(await stopped(provisionFederationStorage({ ...OPTS, mastersBucket: "replacement-masters", apply: false }, b.providers, () => {}))).toMatch(
      /acme-masters is tagged as the production tiles bucket of federation acme .*; it cannot be the masters bucket of federation acme/,
    );
    expect(writeCalls(b.world.calls.slice(before))).toEqual([]);

    // Tagged for staging, it moves out of production's record with its tag unchanged.
    const c = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, c.providers, () => {});
    const staged = { "fisqua-role": "masters", "fisqua-env": "staging", "fisqua-federation": "acme" };
    c.world.b2.buckets.get("acme-masters")!.bucketInfo = { ...staged };
    c.world.b2.buckets.set("replacement-masters", { bucketId: "b-repl", bucketName: "replacement-masters", bucketType: "allPrivate", corsRules: [] });
    await provisionFederationStorage({ ...OPTS, mastersBucket: "replacement-masters", apply: true }, c.providers, () => {});
    expect(c.world.d1.federations[0].pipeline_masters_bucket).toBe("replacement-masters");
    expect(c.world.b2.buckets.get("acme-masters")!.bucketInfo).toEqual(staged);
  });
});

describe("outgoing tiles and review-tiles buckets", () => {
  const VALUES: DestinationValues = {
    pipeline_delivery_endpoint: FAKE_B2_S3,
    pipeline_tiles_bucket: "replacement-iiif-tiles",
    pipeline_masters_bucket: "existing-masters",
    pipeline_image_base_url: "https://iiif.existing.example.test",
    manifest_endpoint: FAKE_R2_S3,
    manifest_bucket: "existing-manifests",
    manifest_base_url: "https://manifests.existing.example.test",
    storage_secret_prefix: "FEDERATION_NEOGRANADINA",
  };

  it("tags a replaced tiles bucket, so staging cannot take it as its working bucket", async () => {
    const { world, providers } = fakeWorld({ federation: "neogranadina", tenant: "neogranadina" });
    // A legacy, untagged production tiles bucket that happens to bear the
    // staging working bucket's name, holding published tiles.
    world.b2.buckets.set("fisqua-pipeline-working-staging", {
      bucketId: "b-old-tiles", bucketName: "fisqua-pipeline-working-staging", bucketType: "allPrivate", corsRules: [],
    });
    world.b2.files.set("b-old-tiles", [{ fileName: "neogranadina/co-1/info.json", contentLength: 1 }]);
    Object.assign(world.d1.federations[0], { ...VALUES, pipeline_tiles_bucket: "fisqua-pipeline-working-staging" });
    world.b2.buckets.set("replacement-iiif-tiles", { bucketId: "b-t", bucketName: "replacement-iiif-tiles", bucketType: "allPublic", corsRules: [] });
    world.b2.buckets.set("existing-masters", { bucketId: "b-m", bucketName: "existing-masters", bucketType: "allPrivate", corsRules: [] });
    world.cf.r2.add("existing-manifests");

    // Replacement production storage is adopted.
    const out = capture();
    await adoptFederationStorage({ slug: "neogranadina", target: "production", values: VALUES, apply: true }, providers, out.log);
    expect(out.text()).toContain("[note] the tiles bucket fisqua-pipeline-working-staging the record moves away from keeps its tiles tag");
    expect(world.b2.buckets.get("fisqua-pipeline-working-staging")!.bucketInfo).toEqual({
      "fisqua-role": "tiles", "fisqua-env": "production", "fisqua-federation": "neogranadina",
    });

    // Staging then sets up its working bucket and tenant keys.
    const keys = world.b2.keys.length;
    expect(await stopped(provisionWorkingBucket({ target: "staging", apply: true }, providers, () => {}))).toMatch(
      /fisqua-pipeline-working-staging is tagged as the production tiles bucket of federation neogranadina .*; it cannot be the staging working bucket/,
    );
    expect(
      await stopped(
        provisionTenantStorage(
          { slug: "neogranadina", target: "staging", workingBucket: "fisqua-pipeline-working-staging", apply: true },
          providers,
          () => {},
        ),
      ),
      // It stops at the first bucket tagged for production; either way, no key.
    ).toMatch(/is tagged as the production tiles bucket of federation neogranadina/);
    expect(world.b2.keys).toHaveLength(keys);
    expect(world.b2.keys.some((k) => k.bucketId === "b-old-tiles")).toBe(false);
  });

  it("tags a replaced review-tiles bucket as review tiles", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    world.d1.federations[0].pipeline_review_tiles_bucket = "acme-old-review";
    world.b2.buckets.set("acme-old-review", { bucketId: "b-old-review", bucketName: "acme-old-review", bucketType: "allPrivate", corsRules: [] });
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.b2.buckets.get("acme-old-review")!.bucketInfo).toEqual({
      "fisqua-role": "review-tiles", "fisqua-env": "production", "fisqua-federation": "acme",
    });
  });
});

describe("the working bucket command and files", () => {
  it("refuses an untagged bucket holding files, adopts an empty one, and keeps a tagged one", async () => {
    const a = fakeWorld();
    a.world.b2.buckets.set("fisqua-pipeline-working", { bucketId: "b-w", bucketName: "fisqua-pipeline-working", bucketType: "allPrivate", corsRules: [] });
    a.world.b2.files.set("b-w", [{ fileName: "x/old.json", contentLength: 1 }]);
    for (const apply of [false, true]) {
      expect(await stopped(provisionWorkingBucket({ target: "production", apply }, a.providers, () => {}))).toBe(
        "The B2 bucket fisqua-pipeline-working holds files and is not tagged as the production working bucket; " +
          "the command adopts only an empty bucket as the working bucket and never deletes files",
      );
    }
    expect(a.world.b2.keys).toEqual([]);

    const b = fakeWorld();
    b.world.b2.buckets.set("fisqua-pipeline-working", { bucketId: "b-w", bucketName: "fisqua-pipeline-working", bucketType: "allPrivate", corsRules: [] });
    await provisionWorkingBucket({ target: "production", apply: true }, b.providers, () => {});
    expect(b.world.b2.buckets.get("fisqua-pipeline-working")!.bucketInfo).toEqual({ "fisqua-role": "working", "fisqua-env": "production" });

    // Tagged as working, it is kept even with files in it.
    b.world.b2.files.set("b-w", [{ fileName: "t/report.json", contentLength: 1 }]);
    const before = b.world.calls.length;
    await provisionWorkingBucket({ target: "production", apply: true }, b.providers, () => {});
    expect(writeCalls(b.world.calls.slice(before))).toEqual([]);
  });
});

describe("the provisioning lock", () => {
  it("refuses a second applied federation run while the first holds the lock, and releases it after", async () => {
    const { world, providers } = fakeWorld();
    let second: string | null = null;
    const put = providers.cloudflare!.putTransformRules;
    providers.cloudflare!.putTransformRules = async (zone, rules) => {
      // Run A pauses here; run B starts meanwhile.
      if (second === null) {
        second = await stopped(provisionFederationStorage({ ...OPTS, apply: true }, { ...providers, holder: "run-b" }, () => {}));
      }
      await put(zone, rules);
    };
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(second).toBe(
      `Another provisioning run holds the lock on federation:${FAKE_FEDERATION_ID}: fake-run, since ${new Date(1_800_000_000_000).toISOString()}. ` +
        "Run the command again once it has finished; a lock left by a run that crashed expires 30 minutes after it was taken",
    );
    // Run B issued nothing: every key is run A's, once.
    expect(world.b2.keys.map((k) => k.name)).toEqual([
      "fisqua-acme-tiles-fisqua-read",
      "fisqua-acme-masters-list",
      "fisqua-acme-review-tiles-fisqua-share",
    ]);
    expect(world.d1.locks.size).toBe(0);
  });

  it("takes no lock in a dry run, takes over an expired one, and releases it when the run stops", async () => {
    const a = fakeWorld();
    a.world.d1.locks.set(`federation:${FAKE_FEDERATION_ID}`, { holder: "someone", token: "t-someone", startedAt: 1, expiresAt: 2 });
    await provisionFederationStorage({ ...OPTS, apply: true }, a.providers, () => {});
    expect(a.world.d1.locks.size).toBe(0);

    const b = fakeWorld();
    b.world.d1.locks.set(`federation:${FAKE_FEDERATION_ID}`, { holder: "someone", token: "t-someone", startedAt: 1_800_000_000_000 - 60_000, expiresAt: 1_800_000_000_000 + 60_000 });
    await provisionFederationStorage({ ...OPTS, apply: false }, b.providers, () => {});
    expect(b.world.calls.filter((c) => c.startsWith("d1.takeLock"))).toEqual([]);
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, b.providers, () => {}))).toMatch(/holds the lock .*: someone, since/);

    const c = fakeWorld();
    c.world.b2.taken.add("acme-iiif-tiles");
    await stopped(provisionFederationStorage({ ...OPTS, apply: true }, c.providers, () => {}));
    expect(c.world.d1.locks.size).toBe(0);
  });

  it("refuses a second applied tenant run while the first holds the lock", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    world.b2.buckets.get(FAKE_WORKING_BUCKET)!.bucketInfo = { "fisqua-role": "working", "fisqua-env": "production" };
    let second: string | null = null;
    const create = providers.github!.createEnvironment;
    providers.github!.createEnvironment = async (name) => {
      second = await stopped(
        provisionTenantStorage({ slug: "sbmal", target: "production", workingBucket: FAKE_WORKING_BUCKET, apply: true }, { ...providers, holder: "run-b" }, () => {}),
      );
      await create(name);
    };
    await provisionTenantStorage({ slug: "sbmal", target: "production", workingBucket: FAKE_WORKING_BUCKET, apply: true }, providers, () => {});
    expect(second).toMatch(/^Another provisioning run holds the lock on tenant:.*: fake-run, since /);
    expect(world.b2.keys.filter((k) => k.name.startsWith("fisqua-sbmal-")).map((k) => k.name)).toHaveLength(7);
    expect(world.d1.locks.size).toBe(0);
  });
});

describe("held keys checked against the accounts", () => {
  it("issues a held Fisqua key again when no live key of its name, bucket and capabilities is in the account", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    world.b2.keys = world.b2.keys.filter((k) => k.name !== "fisqua-acme-masters-list");
    world.b2.keys.find((k) => k.name === "fisqua-acme-review-tiles-fisqua-share")!.capabilities = ["listBuckets", "listFiles", "readFiles", "shareFiles", "writeFiles"];
    world.cf.tokens = [];
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(
      "[reissue] would issue fisqua-acme-masters-list again: B2 key, list only, limited to acme-masters (Fisqua), and replace the secrets that hold it, " +
        "because no key named fisqua-acme-masters-list in the B2 account is limited to acme-masters/",
    );
    expect(dry.text()).toContain(
      "because the key named fisqua-acme-review-tiles-fisqua-share in the B2 account has the capabilities " +
        "listBuckets,listFiles,readFiles,shareFiles,writeFiles, not listBuckets,listFiles,readFiles,shareFiles",
    );
    expect(dry.text()).toContain(
      "[reissue] would issue fisqua-acme-manifests-write again: R2 token, object write, limited to acme-manifests (Fisqua), " +
        "and replace the secrets that hold it, because no token named fisqua-acme-manifests-write is in the Cloudflare account",
    );
    expect(dry.text()).toContain("[exists] fisqua-acme-tiles-fisqua-read");
  });
});

describe("pairs whose secrets were left half written", () => {
  const SCOPE = `federation:${FAKE_FEDERATION_ID}`;
  const SHARE = "fisqua-acme-review-tiles-fisqua-share";

  it("deletes the new key when its second secret fails, and the rerun issues the pair again from scratch", async () => {
    let failing = false;
    const { world, providers } = fakeWorld({ failOn: (c) => failing && c === "worker.put:FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY" });
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    const reviewId = world.b2.buckets.get("acme-review-tiles")!.bucketId;
    // The live share key goes; its two secrets stay.
    world.b2.keys = world.b2.keys.filter((k) => k.name !== SHARE);
    const oldSecret = world.worker.get("FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY");

    failing = true;
    const message = await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}));
    failing = false;
    expect(message).toMatch(
      new RegExp(`^Writing the secrets of ${SHARE} failed \\(fake failure at worker.put:FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY\\); the new key ${SHARE} \\(FAKEKEYID\\d+\\) was deleted\\. ${SHARE} is marked as half written \\(by this run, read back from D1\\), and the next run issues it again from scratch$`),
    );
    // The new id sits beside the old secret, no key of the name is left, and the pair is marked.
    expect(world.worker.get("FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY")).toBe(oldSecret);
    expect(world.b2.keys.some((k) => k.name === SHARE)).toBe(false);
    expect([...world.d1.pendingPairs.keys()]).toEqual([`${SCOPE} ${SHARE}`]);

    // Even with a correctly scoped live key of the name, the marked pair is issued again.
    world.b2.keys.push({ name: SHARE, bucketId: reviewId, capabilities: ["listBuckets", "listFiles", "readFiles", "shareFiles"] });
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(
      `[reissue] would issue ${SHARE} again: B2 key, list, read and share, limited to acme-review-tiles (Fisqua), and replace the secrets that hold it, ` +
        "because an earlier run began writing its two secrets and did not finish, so they may hold two different keys",
    );
    expect(dry.text()).toContain("[would replace] FEDERATION_ACME_REVIEW_SHARE_KEY_ID");
    expect(dry.text()).toContain("[would replace] FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY");
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    const id = world.worker.get("FEDERATION_ACME_REVIEW_SHARE_KEY_ID")!;
    expect(world.worker.get("FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY")).toBe(id.replace("FAKEKEYID", "FAKESECRET"));
    expect(world.d1.pendingPairs.size).toBe(0);
  });

  it("reports a new key left in the account when it cannot be deleted either", async () => {
    let failing = false;
    const { world, providers } = fakeWorld({
      failOn: (c) => failing && (c === "worker.put:FEDERATION_ACME_MASTERS_LIST_SECRET_KEY" || c.startsWith("b2.deleteKey:")),
    });
    failing = true;
    const message = await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}));
    expect(message).toMatch(
      /the new key fisqua-acme-masters-list \(FAKEKEYID\d+\) could not be deleted and is left in the account; delete it by hand\. fisqua-acme-masters-list is marked as half written \(by this run, read back from D1\)/,
    );
    expect(world.b2.keys.filter((k) => k.name === "fisqua-acme-masters-list")).toHaveLength(1);
    expect([...world.d1.pendingPairs.keys()]).toEqual([`${SCOPE} fisqua-acme-masters-list`]);
  });

  it("issues again the pairs a crashed run left marked, tiles and masters alike", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    world.d1.pendingPairs.set(`${SCOPE} fisqua-acme-tiles-fisqua-read`, "t-crashed");
    world.d1.pendingPairs.set(`${SCOPE} fisqua-acme-masters-list`, "t-crashed");
    const before = new Map(world.worker);
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain("[reissue] would issue fisqua-acme-tiles-fisqua-read again");
    expect(dry.text()).toContain("[reissue] would issue fisqua-acme-masters-list again");
    expect(dry.text()).toContain("[would replace] FEDERATION_ACME_DELIVERY_READ_SECRET_KEY");
    expect(dry.text()).toContain("[would replace] FEDERATION_ACME_MASTERS_LIST_SECRET_KEY");
    expect(dry.text()).toContain("[exists] FEDERATION_ACME_REVIEW_SHARE_KEY_ID");
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.worker.get("FEDERATION_ACME_DELIVERY_READ_KEY_ID")).not.toBe(before.get("FEDERATION_ACME_DELIVERY_READ_KEY_ID"));
    expect(world.worker.get("FEDERATION_ACME_MASTERS_LIST_KEY_ID")).not.toBe(before.get("FEDERATION_ACME_MASTERS_LIST_KEY_ID"));
    expect(world.worker.get("FEDERATION_ACME_REVIEW_SHARE_KEY_ID")).toBe(before.get("FEDERATION_ACME_REVIEW_SHARE_KEY_ID"));
    expect(world.d1.pendingPairs.size).toBe(0);
  });

  it("leaves no mark after a run that writes every pair", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.d1.pendingPairs.size).toBe(0);
    const marked = world.calls.filter((c) => c.startsWith("d1.markPair:")).map((c) => c.slice("d1.markPair:".length));
    const cleared = world.calls.filter((c) => c.startsWith("d1.clearPair:")).map((c) => c.slice("d1.clearPair:".length));
    expect(marked).toEqual(["fisqua-acme-tiles-fisqua-read", "fisqua-acme-manifests-write", "fisqua-acme-masters-list", SHARE]);
    expect(cleared).toEqual(marked);
  });

  it("shows the secrets as to be replaced for every reissue the live-key check finds", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    world.b2.keys = world.b2.keys.filter((k) => k.name !== SHARE);
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(`[reissue] would issue ${SHARE} again`);
    expect(dry.text()).toContain("[would replace] FEDERATION_ACME_REVIEW_SHARE_KEY_ID");
    expect(dry.text()).toContain("[would replace] FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY");
    expect(dry.text()).toContain("[exists] FEDERATION_ACME_MASTERS_LIST_KEY_ID");
  });
});

describe("the lock's fencing token", () => {
  const SCOPE = `federation:${FAKE_FEDERATION_ID}`;
  const SHARE = "fisqua-acme-review-tiles-fisqua-share";
  const MINUTE = 60_000;

  it("marks the pair again when its write lands after the lock was lost, and the next run repairs it", async () => {
    const { world, providers } = fakeWorld();
    let clock = 1_800_000_000_000;
    providers.now = () => clock;
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    world.b2.keys = world.b2.keys.filter((k) => k.name !== SHARE);

    // Run A pauses in its write of the share secret, past its lock's expiry;
    // run B takes the lock over and writes the whole pair.
    let paused = false;
    const put = providers.worker!.put;
    providers.worker!.put = async (name, value) => {
      if (!paused && name === "FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY") {
        paused = true;
        clock += 31 * MINUTE;
        await provisionFederationStorage({ ...OPTS, apply: true }, { ...providers, holder: "run-b" }, () => {});
      }
      await put(name, value);
    };
    const message = await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}));
    expect(paused).toBe(true);
    expect(message).toMatch(
      new RegExp(`^The provisioning lock on ${SCOPE} was lost .*; the new key ${SHARE} \\(FAKEKEYID\\d+\\) is left in the account; delete it by hand\\. ${SHARE} is marked as half written \\(by this run, read back from D1\\), and the next run issues it again from scratch$`),
    );
    // A's secret landed beside B's id; A did not clear the mark, it marked the pair again.
    const id = world.worker.get("FEDERATION_ACME_REVIEW_SHARE_KEY_ID")!;
    const secret = world.worker.get("FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY")!;
    expect(secret).not.toBe(id.replace("FAKEKEYID", "FAKESECRET"));
    expect([...world.d1.pendingPairs.keys()]).toEqual([`${SCOPE} ${SHARE}`]);

    // The next run issues the pair again, whole.
    providers.worker!.put = put;
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(`[reissue] would issue ${SHARE} again`);
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    const fixed = world.worker.get("FEDERATION_ACME_REVIEW_SHARE_KEY_ID")!;
    expect(world.worker.get("FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY")).toBe(fixed.replace("FAKEKEYID", "FAKESECRET"));
    expect(world.d1.pendingPairs.size).toBe(0);
  });

  it("stops without writing a secret when the lock is lost before the write", async () => {
    const { world, providers } = fakeWorld();
    let clock = 1_800_000_000_000;
    providers.now = () => clock;
    // The lock is lost while the first key is being issued.
    const createKey = providers.b2!.createKey;
    providers.b2!.createKey = async (...args) => {
      clock += 31 * MINUTE;
      world.d1.locks.set(SCOPE, { holder: "run-b", token: "t-b", startedAt: clock, expiresAt: clock + 30 * MINUTE });
      return createKey(...args);
    };
    const message = await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}));
    expect(message).toMatch(/^The provisioning lock on .* was lost .*fisqua-acme-tiles-fisqua-read is marked as half written \(by this run, read back from D1\)/);
    expect(world.calls.filter((c) => c.startsWith("worker.put:"))).toEqual([]);
    expect([...world.d1.pendingPairs.keys()]).toEqual([`${SCOPE} fisqua-acme-tiles-fisqua-read`]);
    // The other run's lock is left alone.
    expect(world.d1.locks.get(SCOPE)!.holder).toBe("run-b");
  });

  it("renews the lock at each write, so a slow run keeps it and a second run is still refused", async () => {
    const { world, providers } = fakeWorld();
    let clock = 1_800_000_000_000;
    providers.now = () => clock;
    let refused: string | null = null;
    const put = providers.worker!.put;
    providers.worker!.put = async (name, value) => {
      // Each secret write takes 10 minutes: 80 in all, past the 30-minute lock.
      clock += 10 * MINUTE;
      if (name === "FEDERATION_ACME_REVIEW_SHARE_KEY_ID") {
        refused = await stopped(provisionFederationStorage({ ...OPTS, apply: true }, { ...providers, holder: "run-b" }, () => {}));
      }
      await put(name, value);
    };
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(refused).toMatch(/^Another provisioning run holds the lock on federation:.*: fake-run, since /);
    expect(world.worker.size).toBe(8);
    expect(world.d1.pendingPairs.size).toBe(0);
    expect(world.calls.filter((c) => c.startsWith("d1.renewLock:")).length).toBeGreaterThanOrEqual(16);
  });

  it("reports an incomplete pair's existing secret as to be replaced", async () => {
    let failing = true;
    const { world, providers } = fakeWorld({ failOn: (c) => failing && c === "worker.put:FEDERATION_ACME_MASTERS_LIST_SECRET_KEY" });
    await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}));
    failing = false;
    expect(world.worker.has("FEDERATION_ACME_MASTERS_LIST_KEY_ID")).toBe(true);
    expect(world.worker.has("FEDERATION_ACME_MASTERS_LIST_SECRET_KEY")).toBe(false);
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain("[would replace] FEDERATION_ACME_MASTERS_LIST_KEY_ID");
    expect(dry.text()).toContain("[would set] FEDERATION_ACME_MASTERS_LIST_SECRET_KEY");
    expect(dry.text()).not.toContain("[exists] FEDERATION_ACME_MASTERS_LIST_KEY_ID");
  });
});

describe("marks owned by the run that wrote them", () => {
  const SCOPE = `federation:${FAKE_FEDERATION_ID}`;
  const SHARE = "fisqua-acme-review-tiles-fisqua-share";
  const ID = "FEDERATION_ACME_REVIEW_SHARE_KEY_ID";
  const SECRET = "FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY";

  it("keeps a stale writer's re-mark from being cleared by the run that took over, and the next run repairs the pair", async () => {
    const { world, providers } = fakeWorld();
    let clock = 1_800_000_000_000;
    providers.now = () => clock;
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    world.b2.keys = world.b2.keys.filter((k) => k.name !== SHARE);

    let signalBAtSecret!: () => void;
    const bAtSecret = new Promise<void>((r) => (signalBAtSecret = r));
    let releaseB!: () => void;
    const bMayWrite = new Promise<void>((r) => (releaseB = r));
    let aPaused = false;
    let bPaused = false;
    let bRun: Promise<string> | null = null;
    const put = providers.worker!.put;
    providers.worker!.put = async (name, value) => {
      if (name === ID && !aPaused) {
        // 1. A pauses after its pre-write renewal, before writing the id.
        aPaused = true;
        clock += 31 * 60_000;
        // 2. B takes over and writes its id, then waits before its secret.
        bRun = stopped(provisionFederationStorage({ ...OPTS, apply: true }, { ...providers, holder: "run-b" }, () => {}));
        await bAtSecret;
      } else if (name === SECRET && aPaused && !bPaused) {
        bPaused = true;
        signalBAtSecret();
        await bMayWrite;
      }
      await put(name, value);
    };

    // 3. A resumes, overwrites the id, finds its lock lost and marks the pair again.
    const aMessage = await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}));
    expect(aMessage).toMatch(/^The provisioning lock on .* was lost/);
    const aToken = world.d1.pendingPairs.get(`${SCOPE} ${SHARE}`);
    expect(aToken).toBeDefined();

    // 4. B writes its secret; its clear finds A's mark, not its own, and B stops.
    releaseB();
    const bMessage = await bRun!;
    expect(bMessage).toBe(
      `Another writer touched ${SHARE} while this run wrote it (its mark is no longer this run's, or the lock is lost), ` +
        `so the pair is not taken as complete: its secrets may hold two different keys. ${SHARE} is marked as half written ` +
        "(by another run, read back from D1), and the next run issues it again from scratch",
    );

    // 5. A's id with B's secret, and the mark kept.
    const id = world.worker.get(ID)!;
    expect(world.worker.get(SECRET)).not.toBe(id.replace("FAKEKEYID", "FAKESECRET"));
    expect(world.d1.pendingPairs.get(`${SCOPE} ${SHARE}`)).toBe(aToken);

    // The next run issues the pair again, matching, and clears its own mark.
    providers.worker!.put = put;
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    const fixed = world.worker.get(ID)!;
    expect(world.worker.get(SECRET)).toBe(fixed.replace("FAKEKEYID", "FAKESECRET"));
    expect(world.d1.pendingPairs.size).toBe(0);
  });

  it("clears its own mark in an ordinary run", async () => {
    const { world, providers } = fakeWorld();
    let seen: string | undefined;
    const put = providers.worker!.put;
    providers.worker!.put = async (name, value) => {
      if (name === SECRET) seen = world.d1.pendingPairs.get(`${SCOPE} ${SHARE}`);
      await put(name, value);
    };
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    // While it wrote, the mark was there, with this run's token, the lock's.
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    expect(world.d1.pendingPairs.size).toBe(0);
  });
});

describe("a secret write that throws", () => {
  const SCOPE = `federation:${FAKE_FEDERATION_ID}`;
  const SHARE = "fisqua-acme-review-tiles-fisqua-share";
  const ID = "FEDERATION_ACME_REVIEW_SHARE_KEY_ID";
  const SECRET = "FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY";
  const matching = (world: ReturnType<typeof fakeWorld>["world"]) =>
    world.worker.get(SECRET) === world.worker.get(ID)!.replace("FAKEKEYID", "FAKESECRET");

  it("is taken as possibly applied: a lost response after the lock expired leaves the pair marked, and the next run repairs it", async () => {
    const { world, providers } = fakeWorld();
    let clock = 1_800_000_000_000;
    providers.now = () => clock;
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    world.b2.keys = world.b2.keys.filter((k) => k.name !== SHARE);

    let paused = false;
    const put = providers.worker!.put;
    providers.worker!.put = async (name, value) => {
      if (!paused && name === SECRET) {
        // A's second secret request hangs past its lock's expiry; B takes
        // over and writes both secrets and clears its mark.
        paused = true;
        clock += 31 * 60_000;
        await provisionFederationStorage({ ...OPTS, apply: true }, { ...providers, holder: "run-b" }, () => {});
        expect(world.d1.pendingPairs.size).toBe(0);
        // A's request then lands remotely, but its response is lost.
        await put(name, value);
        throw new Error("the response was lost");
      }
      await put(name, value);
    };
    const message = await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}));
    expect(message).toMatch(
      new RegExp(`^The provisioning lock on ${SCOPE} was lost .*; the new key ${SHARE} \\(FAKEKEYID\\d+\\) is left in the account; delete it by hand\\. ${SHARE} is marked as half written \\(by this run, read back from D1\\)`),
    );
    // B's id beside A's secret, and the pair marked.
    expect(matching(world)).toBe(false);
    expect(world.d1.pendingPairs.has(`${SCOPE} ${SHARE}`)).toBe(true);

    providers.worker!.put = put;
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(matching(world)).toBe(true);
    expect(world.d1.pendingPairs.size).toBe(0);
  });

  it("leaves the pair marked when it throws with the lock still held, and the next run issues it again", async () => {
    const { world, providers } = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    world.b2.keys = world.b2.keys.filter((k) => k.name !== SHARE);
    let thrown = false;
    const put = providers.worker!.put;
    providers.worker!.put = async (name, value) => {
      await put(name, value);
      if (!thrown && name === SECRET) {
        // Applied remotely; the run hears an error.
        thrown = true;
        throw new Error("the response was lost");
      }
    };
    const message = await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}));
    expect(message).toMatch(
      new RegExp(`^Writing the secrets of ${SHARE} failed \\(the response was lost\\); the new key ${SHARE} \\(FAKEKEYID\\d+\\) was deleted\\. ${SHARE} is marked as half written \\(by this run, read back from D1\\)`),
    );
    expect(world.d1.pendingPairs.has(`${SCOPE} ${SHARE}`)).toBe(true);
    const dry = capture();
    await provisionFederationStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(`[reissue] would issue ${SHARE} again`);
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(matching(world)).toBe(true);
    expect(world.d1.pendingPairs.size).toBe(0);
  });

  it("states what is left when the key cannot be issued", async () => {
    let failing = true;
    const { world, providers } = fakeWorld({ failOn: (c) => failing && c === "b2.createKey:fisqua-acme-masters-list" });
    const message = await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}));
    failing = false;
    expect(message).toBe(
      "Issuing fisqua-acme-masters-list failed (fake failure at b2.createKey:fisqua-acme-masters-list); no key was issued and no secret was written. " +
        "fisqua-acme-masters-list is marked as half written (by this run, read back from D1), and the next run issues it again from scratch",
    );
    expect(world.worker.has("FEDERATION_ACME_MASTERS_LIST_KEY_ID")).toBe(false);
  });
});

describe("fenced D1 writes", () => {
  const SCOPE = `federation:${FAKE_FEDERATION_ID}`;

  /** acme provisioned before the review-tiles bucket existed, with a replacement masters bucket ready. */
  async function before() {
    const w = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, w.providers, () => {});
    w.world.b2.buckets.delete("acme-review-tiles");
    w.world.b2.keys = w.world.b2.keys.filter((k) => !k.name.includes("review-tiles"));
    w.world.worker.delete("FEDERATION_ACME_REVIEW_SHARE_KEY_ID");
    w.world.worker.delete("FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY");
    w.world.d1.federations[0].pipeline_review_tiles_bucket = null;
    w.world.b2.buckets.set("replacement-masters", { bucketId: "b-repl", bucketName: "replacement-masters", bucketType: "allPrivate", corsRules: [] });
    return w;
  }

  it("refuses a stale run's destination write after another run took the expired lock, and the other run's record stands", async () => {
    const { world, providers } = await before();
    let clock = 1_800_000_000_000;
    providers.now = () => clock;
    let paused = false;
    const write = providers.d1.writeDestination;
    providers.d1.writeDestination = async (...args) => {
      if (!paused) {
        // A pauses before recording its destination; B takes the expired
        // lock, replaces the masters bucket and completes.
        paused = true;
        clock += 31 * 60_000;
        await provisionFederationStorage({ ...OPTS, mastersBucket: "replacement-masters", apply: true }, { ...providers, holder: "run-b" }, () => {});
      }
      return write(...args);
    };
    const message = await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}));
    expect(paused).toBe(true);
    expect(message).toBe(
      "The federation record of acme was not written: this run's provisioning lock was lost, or another run changed the record " +
        "since this run read it. Its buckets, keys and secrets may already reflect this run; run the command again, which reads the record afresh",
    );
    expect(world.d1.federations[0]).toMatchObject({
      pipeline_masters_bucket: "replacement-masters",
      pipeline_review_tiles_bucket: "acme-review-tiles",
    });
    expect(world.d1.pendingPairs.size).toBe(0);
  });

  it("refuses a destination write whose snapshot is stale, with the lock still held", async () => {
    const { world, providers } = await before();
    const write = providers.d1.writeDestination;
    providers.d1.writeDestination = async (...args) => {
      // Another writer changes the record between this run's read and its write.
      world.d1.federations[0].pipeline_image_base_url = "https://iiif-changed.acme.example.test";
      return write(...args);
    };
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}))).toMatch(
      /^The federation record of acme was not written/,
    );
    expect(world.d1.federations[0]).toMatchObject({
      pipeline_image_base_url: "https://iiif-changed.acme.example.test",
      pipeline_review_tiles_bucket: null,
    });
    expect(world.d1.locks.size).toBe(0);
  });

  it("marks no pair when the lock is lost between the renewal and the mark", async () => {
    const { world, providers } = fakeWorld();
    const mark = providers.d1.markPair;
    providers.d1.markPair = async (scope, pair, holder, token, now, fenced) => {
      // The lock expires just after its renewal and before the mark.
      if (fenced) world.d1.locks.get(scope)!.expiresAt = now;
      return mark(scope, pair, holder, token, now, fenced);
    };
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {}))).toMatch(
      /^The provisioning lock on .* was lost/,
    );
    expect(world.d1.pendingPairs.size).toBe(0);
    expect(world.b2.keys).toEqual([]);
    expect(world.worker.size).toBe(0);
    expect(world.d1.writes).toBe(0);
    expect(world.calls).toContain(`d1.releaseLock:${SCOPE}`);
  });
});

describe("the pending-work exemption and the account endpoints", () => {
  /** acme provisioned before the review-tiles bucket, with work pending and a half-written manifest pair. */
  async function pendingBefore() {
    const w = fakeWorld();
    await provisionFederationStorage({ ...OPTS, apply: true }, w.providers, () => {});
    w.world.b2.buckets.delete("acme-review-tiles");
    w.world.b2.keys = w.world.b2.keys.filter((k) => !k.name.includes("review-tiles"));
    w.world.worker.delete("FEDERATION_ACME_REVIEW_SHARE_KEY_ID");
    w.world.worker.delete("FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY");
    w.world.d1.federations[0].pipeline_review_tiles_bucket = null;
    w.world.d1.openRuns = 1;
    w.world.d1.pendingPairs.set(`federation:${FAKE_FEDERATION_ID} fisqua-acme-manifests-write`, "t-earlier");
    return w;
  }

  it("refuses before any key or secret when the Cloudflare credentials are another account's", async () => {
    const { world, providers } = await pendingBefore();
    // Another R2 account holding the expected bucket and host, with no matching token.
    const other = { ...providers.cloudflare!, s3Endpoint: "https://otheraccount.r2.cloudflarestorage.com" };
    world.cf.tokens = [];
    const secrets = new Map(world.worker);
    const keys = world.b2.keys.length;
    for (const apply of [false, true]) {
      const before = world.calls.length;
      expect(await stopped(provisionFederationStorage({ ...OPTS, apply }, { ...providers, cloudflare: other }, () => {}))).toMatch(
        /The federation's tenants have 1 open run\(s\); its storage record cannot change/,
      );
      expect(writeCalls(world.calls.slice(before))).toEqual([]);
    }
    expect(world.worker).toEqual(secrets);
    expect(world.b2.keys).toHaveLength(keys);
    expect(world.cf.tokens).toEqual([]);
    expect([...world.d1.pendingPairs.keys()]).toEqual([`federation:${FAKE_FEDERATION_ID} fisqua-acme-manifests-write`]);
    expect(world.d1.federations[0].manifest_endpoint).toBe(FAKE_R2_S3);
  });

  it("refuses the same way when the B2 credentials give another endpoint", async () => {
    const { world, providers } = await pendingBefore();
    const b2 = { ...providers.b2!, account: async () => ({ s3ApiUrl: "https://s3.eu-central-003.backblazeb2.com", downloadUrl: FAKE_B2_DOWNLOAD }) };
    const before = world.calls.length;
    expect(await stopped(provisionFederationStorage({ ...OPTS, apply: true }, { ...providers, b2 }, () => {}))).toMatch(/1 open run/);
    expect(writeCalls(world.calls.slice(before))).toEqual([]);
  });

  it("goes ahead with matching endpoints, adding only the review-tiles bucket despite the pending work", async () => {
    const { world, providers } = await pendingBefore();
    world.d1.pendingPairs.clear();
    const secrets = new Map(world.worker);
    await provisionFederationStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.d1.federations[0]).toMatchObject({
      pipeline_delivery_endpoint: FAKE_B2_S3,
      manifest_endpoint: FAKE_R2_S3,
      pipeline_review_tiles_bucket: "acme-review-tiles",
    });
    for (const [name, value] of secrets) expect(world.worker.get(name)).toBe(value);
    expect(world.worker.size).toBe(secrets.size + 2);
  });
});

// @version v0.8.0
