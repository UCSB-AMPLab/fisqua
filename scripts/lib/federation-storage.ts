/**
 * Scripts — federation storage: the federation step
 *
 * This module deals with the storage a federation's media pipeline
 * output goes to, and with recording it on the federation's row. The
 * buckets belong to the federation; each of its tenants writes under its
 * own slug inside them, with keys the tenant step
 * (`provisionTenantStorage` in `./tenant-storage`) issues. The command
 * `scripts/commands/provision-federation-storage.ts` is a thin shell
 * around this module, and everything here takes its provider clients as
 * arguments, so the tests run every step against fakes.
 *
 * `federationStorageNames(slug, domain, target)` gives the names a new
 * federation's storage takes: the public B2 tiles bucket
 * `{slug}-iiif-tiles`, the private B2 masters bucket `{slug}-masters`,
 * the private B2 review-tiles bucket `{slug}-review-tiles`, the R2
 * manifest bucket `{slug}-manifests`, the hosts `iiif.{domain}` and
 * `manifests.{domain}`, the secret prefix `FEDERATION_{SLUG}`, and the
 * names of Fisqua's four keys. On staging the buckets and keys carry
 * `-staging` after the slug and the hosts become `iiif-staging.{domain}`
 * and `manifests-staging.{domain}`.
 *
 * `provisionFederationStorage(options, providers, log)` walks four steps
 * in order, and every step reads what exists before it writes, so a run
 * that stopped part way finishes the job when run again without making
 * anything twice:
 *
 *   1. Buckets and hosts. The tiles bucket is created public, with a
 *      CORS rule allowing GET and HEAD from any origin; the masters
 *      bucket is created private, with no CORS rule and no host. A name
 *      B2 holds for another account stops the command, which never picks
 *      another name. The manifest bucket is created with the same CORS
 *      rule as the tiles and `manifests.{domain}` is attached to it as a
 *      custom domain. `iiif.{domain}` becomes a proxied CNAME to the
 *      account's B2 download host, with a Transform Rule that puts
 *      `/file/{tiles bucket}` before the path. The domain's zone must
 *      already be in the Cloudflare account. With `mastersBucket` the
 *      federation takes an existing private B2 bucket as its masters
 *      bucket instead: nothing is created or changed on it, and the
 *      command stops if the bucket is not in the B2 account or not
 *      private. It is checked before the tiles bucket is created, so a
 *      wrong name leaves nothing behind. Without `mastersBucket`, a
 *      record that already names a masters bucket keeps it, checked the
 *      same way, and `{slug}-masters` is never planned in its place: the
 *      recorded masters bucket changes only when `mastersBucket` names
 *      another. The other buckets and hosts are provisioned as usual. The review-tiles bucket is created
 *      private, with no lifecycle rule (Fisqua deletes review tiles once
 *      a volume is approved and processed) and one CORS rule
 *      (`reviewTilesCorsRules`) allowing downloads only from the target's
 *      tenant hosts (`reviewTilesOrigins`), never `*` and never the apex.
 *      An existing bucket of that name
 *      is adopted when it is private, has no lifecycle rule, and is empty
 *      of every file version or is the record's own review-tiles bucket
 *      (a rerun); otherwise the command stops. Its
 *      CORS rules are set to that rule when they differ; one with
 *      lifecycle rules stops the command, which names them and never
 *      clears them. Before anything is created, a bucket name that would
 *      serve two roles stops the command: two of the federation's
 *      buckets, one of them and the shared working bucket, one of them
 *      and a bucket the federation's own record holds in another role
 *      (a bucket the run would replace included, so a former masters
 *      bucket never becomes the review-tiles bucket), or one of them and
 *      another federation's bucket of another role
 *      (`refuseBucketAliases`).
 *   2. Fisqua's keys: a B2 read key limited to the tiles bucket,
 *      an R2 API token limited to the manifest bucket (whose S3 secret is
 *      the SHA-256 of the token value), and a B2 key limited to the
 *      masters bucket that can list it and nothing else (`listBuckets`,
 *      `listFiles`), with which the Worker checks that a capture
 *      manifest's masters are in the bucket when a unit delivers it
 *      over the Captua link. With the review-tiles bucket, a fourth:
 *      a B2 key limited to it that can list, read and share
 *      (`listBuckets`, `listFiles`, `readFiles`, `shareFiles`), with
 *      which the Worker issues the viewer's download authorisations. A
 *      key is issued only when one of the Worker secrets that hold it is
 *      missing; then both are written.
 *      An older key with the same name is left in place and reported.
 *      When the record already names another tiles, manifest, masters or review-tiles bucket,
 *      the key limited to that bucket is issued again even though its
 *      secrets are set (`[reissue]`), and the key it replaces is reported
 *      for deletion by hand, never deleted.
 *   3. The eight Worker secrets, `{prefix}_DELIVERY_READ_KEY_ID`,
 *      `{prefix}_DELIVERY_READ_SECRET_KEY`, `{prefix}_MANIFEST_WRITE_KEY_ID`,
 *      `{prefix}_MANIFEST_WRITE_SECRET_KEY`, `{prefix}_MASTERS_LIST_KEY_ID`,
 *      `{prefix}_MASTERS_LIST_SECRET_KEY`, `{prefix}_REVIEW_SHARE_KEY_ID`
 *      and `{prefix}_REVIEW_SHARE_SECRET_KEY`, with `wrangler secret put`.
 *      The dry run reports each as set, to be set or to be replaced.
 *   4. The federation's destination record in D1, written in one
 *      statement fenced by the run's lock and compared with the record as
 *      the run read it: a run whose lock was lost, or whose snapshot
 *      another run has changed since, writes nothing and stops. The write is refused
 *      while any tenant of the federation has pending work (an open run,
 *      or a volume prepared or ready but not yet published), and when
 *      another federation already names one of the buckets, the manifest
 *      address or the prefix (the columns D1's unique indexes cover).
 *      Both checks also run before step 1, so nothing is created, issued
 *      or set for a federation whose record cannot change yet, and no
 *      bucket or Worker secret of another federation is touched. A write
 *      that only adds the review-tiles bucket to a record without one is
 *      not refused for pending work, since no run's destination names
 *      it; this is how a federation provisioned before the bucket existed
 *      gains it, its other columns and keys untouched. When the tiles or masters bucket changes, the output
 *      names the federation's tenants, whose runner keys the tenant step
 *      must then issue again.
 *
 * `adoptFederationStorage(options, providers, log)` records storage that
 * already exists, as for Neogranadina's federation: it creates no bucket
 * and no host, except the review-tiles bucket, which no adopted storage
 * had: it is named and made as provisioning makes it. Every name and address comes from the operator's flags,
 * and the two endpoints must be those of the accounts the command holds
 * credentials for. The tiles and masters buckets must be in the B2
 * account, the masters bucket private, and the manifest bucket in the
 * Cloudflare account; none is created. Before any key is issued, the
 * values are checked against the other federations' records, and a
 * bucket, manifest address or secret prefix another federation already
 * has stops the command. Adoption issues Fisqua's four keys
 * as provisioning does, with the same `[reissue]` rule, sets the eight
 * Worker secrets, and writes the record. On the local target no bucket
 * is made and no key is issued; only the record is written, with the
 * review-tiles bucket it already names, if any.
 *
 * Bucket role tags. Staging and production share one B2 account but not
 * one database, so each bucket's role is also recorded on the bucket, in
 * its bucket info: `fisqua-role` (tiles, masters, review-tiles,
 * working), `fisqua-env` (staging or production) and, except on the
 * shared working bucket, `fisqua-federation` (the federation's slug).
 * A masters bucket is the exception: it serves both environments of its
 * federation, so its tag is `fisqua-role` and `fisqua-federation` only.
 * The command never writes `fisqua-env` on a masters bucket and never
 * compares it there; one that already carries it, of either value, is
 * accepted as it is (`roleCarriesEnv`). A bucket is tagged when the
 * command creates or adopts it, and an untagged existing bucket (one
 * set up before tags) is tagged on a rerun, once every other check has
 * passed, its other bucket-info keys kept. Before anything is created
 * or issued, dry run included, every planned bucket's tag is read, and
 * one naming another role, environment or federation stops the
 * command; on a masters bucket only another role or federation does.
 * The command never
 * removes or changes a tag; a bucket changes role only by an operator's
 * action outside it. Tags are written at the revision read and confirmed
 * in B2 after the write and before any key is issued over the bucket
 * (`tagBucket`, `confirmTag`). A masters bucket the record moves away
 * from, and likewise a tiles or review-tiles bucket, keeps the tag of
 * its role, written before the record changes, so it can never take
 * another role later; one no longer in the account is reported and
 * skipped. An applied run holds the federation's provisioning lock
 * (`withProvisioningLock`), and a held Fisqua key is taken as held only
 * when a live key of its name, bucket and capabilities (or, for the R2
 * token, a token of its name) is in the account and no earlier run left
 * its write half done (`provisioning_pending_pairs`). Section 3 shows as
 * replaced the secrets of every key section 2 issues again. A review-tiles bucket is adopted only when empty or
 * already tagged as this federation's review-tiles bucket for the
 * environment. The manifest bucket is on R2 and carries no tag; a B2
 * bucket of its name is an alias `refuseBucketAliases` covers.
 *
 * In a dry run, which is the default, every step reads and prints what
 * it would do, and nothing is written. No secret value is ever printed.
 *
 * @version v0.8.0
 */

import {
  B2_CORS_RULES,
  B2_READ_CAPABILITIES,
  BUCKET_PATTERN,
  DOMAIN_PATTERN,
  R2_CORS_RULES,
  RECORD_COLUMNS,
  REVIEW_TILES_COLUMN,
  SLUG_PATTERN,
  UNIQUE_COLUMNS,
  lacksTag,
  refuseBucketAliases,
  confirmTag,
  refuseTagConflict,
  limitChange,
  pairJournal,
  PENDING_PAIR_REASON,
  type SecretGuard,
  replacedSecretNames,
  tagBucket,
  withProvisioningLock,
  workingBucketFor,
  isRecordComplete,
  recordValue,
  bucketChange,
  checkDestinationValues,
  ensureB2Bucket,
  has,
  heldKeys,
  hostOf,
  idOf,
  issueKeys,
  nameBase,
  refuseWhilePending,
  secretPrefixFor,
  workerSecretNames,
  ProvisionStop,
  type DestinationValues,
  type B2Api,
  type B2Bucket,
  type BucketRole,
  type BucketTag,
  type FederationRow,
  type HeldKeys,
  type KeyPlan,
  type Log,
  type Providers,
  type Target,
  type TransformRule,
} from "./tenant-storage";
import { mastersListSecretNames } from "../../app/lib/capture/masters.server";
import { reviewShareSecretNames } from "../../app/lib/pipeline/tenant-destination.server";

/** The federation whose existing storage is adopted rather than provisioned. */
export const ADOPTABLE_FEDERATION = "neogranadina";

export interface FederationKeyNames {
  fisquaRead: string;
  manifestWrite: string;
  mastersList: string;
  reviewShare: string;
}

/** List and nothing else: Fisqua checks the masters are there and never reads them. */
export const B2_LIST_CAPABILITIES = ["listBuckets", "listFiles"];

/**
 * List, read and share: Fisqua issues the viewer's download
 * authorisations (`b2_get_download_authorization`) on review tiles.
 */
export const B2_SHARE_CAPABILITIES = ["listBuckets", "listFiles", "readFiles", "shareFiles"];

/**
 * The origins the capture QC viewer runs on for a target: the tenant
 * hosts only (`{slug}.fisqua.org`, on staging `{slug}.staging.fisqua.org`),
 * as `wrangler.jsonc` routes them and `SUBDOMAIN_HOST_SUFFIXES` in
 * `app/lib/tenant.ts` resolves them. The apex (`fisqua.org`,
 * `staging.fisqua.org`) is excluded: it serves no tenant, so it has no
 * review tiles to read. B2 takes one `*` per origin.
 */
export function reviewTilesOrigins(target: "staging" | "production"): string[] {
  return target === "staging" ? ["https://*.staging.fisqua.org"] : ["https://*.fisqua.org"];
}

/**
 * The review-tiles bucket's one CORS rule: downloads (GET and HEAD, by
 * B2's native and S3 operations) from the tenant hosts only, with only
 * the two request headers a viewer sends to B2: `authorization`, which
 * carries the download authorisation Fisqua issues, since the bucket is
 * private, and `range`.
 */
export function reviewTilesCorsRules(target: "staging" | "production"): unknown[] {
  return [
    {
      corsRuleName: "review-tiles-read",
      allowedOrigins: reviewTilesOrigins(target),
      allowedOperations: ["b2_download_file_by_name", "s3_get", "s3_head"],
      allowedHeaders: ["authorization", "range"],
      exposeHeaders: [],
      maxAgeSeconds: 86400,
    },
  ];
}

export interface FederationStorageNames {
  tilesBucket: string;
  mastersBucket: string;
  reviewTilesBucket: string;
  manifestBucket: string;
  tilesHost: string;
  manifestHost: string;
  imageBaseUrl: string;
  manifestBaseUrl: string;
  secretPrefix: string;
  keys: FederationKeyNames;
}

/** The names of Fisqua's four keys for a federation on one target. */
export function federationKeyNames(slug: string, target: Target): FederationKeyNames {
  const base = nameBase(slug, target);
  return {
    fisquaRead: `fisqua-${base}-tiles-fisqua-read`,
    manifestWrite: `fisqua-${base}-manifests-write`,
    mastersList: `fisqua-${base}-masters-list`,
    reviewShare: `fisqua-${base}-review-tiles-fisqua-share`,
  };
}

/** The federation's review-tiles bucket on one target. */
export function reviewTilesBucketFor(slug: string, target: Target): string {
  return `${nameBase(slug, target)}-review-tiles`;
}

export function federationStorageNames(slug: string, domain: string, target: Target): FederationStorageNames {
  if (!SLUG_PATTERN.test(slug)) throw new ProvisionStop(`Not a federation slug: ${slug}`);
  if (!DOMAIN_PATTERN.test(domain)) throw new ProvisionStop(`Not a domain name: ${domain}`);
  const base = nameBase(slug, target);
  const hostSuffix = target === "staging" ? "-staging" : "";
  const tilesHost = `iiif${hostSuffix}.${domain}`;
  const manifestHost = `manifests${hostSuffix}.${domain}`;
  return {
    tilesBucket: `${base}-iiif-tiles`,
    mastersBucket: `${base}-masters`,
    reviewTilesBucket: reviewTilesBucketFor(slug, target),
    manifestBucket: `${base}-manifests`,
    tilesHost,
    manifestHost,
    imageBaseUrl: `https://${tilesHost}`,
    manifestBaseUrl: `https://${manifestHost}`,
    secretPrefix: secretPrefixFor(slug),
    keys: federationKeyNames(slug, target),
  };
}

export interface ProvisionFederationOptions {
  /** The federation's slug. */
  slug: string;
  domain: string;
  target: Target;
  apply: boolean;
  /**
   * An existing private B2 bucket to take as the masters bucket instead
   * of creating `{slug}-masters`. Staging and production may both name
   * the same one; the tenants' prefixes keep test and real material apart,
   * and its tag records no environment.
   * The only way to change a masters bucket the record already names:
   * without it, the recorded one is kept.
   */
  mastersBucket?: string | null;
}

export interface AdoptFederationOptions {
  slug: string;
  target: Target;
  apply: boolean;
  values: DestinationValues;
}

function transformRuleFor(host: string, bucket: string): TransformRule {
  return {
    description: `IIIF tiles on ${host} from the B2 bucket ${bucket}`,
    expression: `(http.host eq "${host}")`,
    action: "rewrite",
    action_parameters: {
      uri: { path: { expression: `concat("/file/${bucket}", http.request.uri.path)` } },
    },
    enabled: true,
  };
}

async function loadFederation(providers: Providers, slug: string): Promise<FederationRow> {
  const federation = await providers.d1.federation(slug);
  if (!federation) throw new ProvisionStop(`No federation has the slug ${slug}`);
  return federation;
}

const PENDING = "its storage record cannot change";

/**
 * Stops when another federation's record already holds a value the
 * planned record would write to a column no two federations may share
 * (`UNIQUE_COLUMNS`, the unique indexes of migration 0091). Run before
 * anything is created, issued or set, and in the dry run, so a colliding
 * bucket, address or secret prefix never reaches another federation's
 * storage or Worker secrets before the record write would be refused.
 */
async function refuseCollisions(
  federation: FederationRow,
  values: Pick<DestinationValues, (typeof UNIQUE_COLUMNS)[number]>,
  providers: Providers,
): Promise<void> {
  for (const other of await providers.d1.otherDestinations(federation.id)) {
    for (const c of UNIQUE_COLUMNS) {
      if (other[c] !== null && other[c] === values[c]) {
        throw new ProvisionStop(`Federation ${other.slug} already has ${c} ${values[c]}`);
      }
    }
  }
}

/**
 * Stops when an existing bucket of the review-tiles bucket's name cannot
 * be adopted: not private; tagged for another role, environment or
 * federation; with lifecycle rules, which could delete review tiles
 * before Fisqua does (the rules are named and left for a person to
 * remove; the command never clears them); or holding any file version
 * without this federation's review-tiles tag for the environment. A
 * bucket no record names any more, such as a masters bucket a record
 * moved away from, keeps its files, and the review keys could read,
 * share or delete them; only an empty bucket, or one already tagged as
 * this review-tiles bucket (a rerun), is adopted. Run before anything is
 * created, dry run included.
 */
async function refuseReviewBucket(
  b2: B2Api,
  bucket: B2Bucket | null,
  name: string,
  tag: BucketTag,
): Promise<void> {
  if (!bucket) return;
  refuseTagConflict(bucket, name, tag);
  if (bucket.bucketType !== "allPrivate") {
    throw new ProvisionStop(`The B2 bucket ${name} exists but is ${bucket.bucketType}, not allPrivate`);
  }
  const rules = bucket.lifecycleRules ?? [];
  if (rules.length > 0) {
    throw new ProvisionStop(
      `The B2 bucket ${name} has lifecycle rules (${JSON.stringify(rules)}), which could delete review tiles ` +
        "before Fisqua does; the command does not adopt it or clear them. Remove them by hand and run the command again",
    );
  }
  if (lacksTag(bucket, tag) && (await b2.hasFileVersions(bucket.bucketId))) {
    throw new ProvisionStop(
      `The B2 bucket ${name} holds files and is not tagged as this federation's ${tag.env} review-tiles bucket; ` +
        "the command adopts only an empty bucket as the review-tiles bucket and never deletes files. " +
        "Check what it holds and run the command again once it is empty or another name is used",
    );
  }
}

/** A bucket the record names in a role and is moving away from. */
interface OutgoingBucket {
  name: string;
  role: "tiles" | "masters" | "review-tiles";
}

/**
 * The tiles, masters and review-tiles buckets the record names that the
 * run would replace. Each keeps a tag for the role it had, so no later
 * run, in either environment, can give it another role (the working
 * role above all, whose key can write).
 */
function outgoingBuckets(
  federation: FederationRow,
  planned: { tiles: string; masters: string; review: string | null },
): OutgoingBucket[] {
  const out: OutgoingBucket[] = [];
  const add = (recorded: string | null | undefined, wanted: string | null, role: OutgoingBucket["role"]) => {
    if (recorded && wanted !== null && recorded !== wanted) out.push({ name: recorded, role });
  };
  add(federation.pipeline_tiles_bucket, planned.tiles, "tiles");
  add(federation.pipeline_masters_bucket, planned.masters, "masters");
  add(federation.pipeline_review_tiles_bucket, planned.review, "review-tiles");
  return out;
}

/**
 * Stops before anything is made when an outgoing bucket is tagged for
 * another role, environment or federation (on a masters bucket, another
 * role or federation).
 */
async function refuseOutgoingConflicts(b2: B2Api, outgoing: OutgoingBucket[], tagFor: (role: BucketRole) => BucketTag): Promise<void> {
  for (const o of outgoing) {
    const bucket = await b2.findBucket(o.name);
    if (bucket) refuseTagConflict(bucket, o.name, tagFor(o.role));
  }
}

/**
 * Tags each bucket the record is moving away from with the role it had,
 * at the revision read (`tagBucket`), before the record changes. A
 * bucket no longer in the account is reported and skipped; one tagged
 * for another role, environment or federation stops the command. A
 * masters bucket is tagged with its role and federation only.
 */
async function tagOutgoing(
  b2: B2Api,
  outgoing: OutgoingBucket[],
  tagFor: (role: BucketRole) => BucketTag,
  apply: boolean,
  log: Log,
): Promise<void> {
  for (const o of outgoing) {
    const bucket = await tagBucket(b2, o.name, tagFor(o.role), apply, log);
    if (bucket === null) {
      log(`  [note] the ${o.role} bucket ${o.name} the record moves away from is not in the B2 account; it is not tagged`);
    } else {
      log(`  [note] the ${o.role} bucket ${o.name} the record moves away from keeps its ${o.role} tag`);
    }
  }
}

/** The buckets Fisqua's keys are limited to, and why any is issued again. */
export interface FisquaKeyTargets {
  keys: FederationKeyNames;
  secrets: ReturnType<typeof workerSecretNames>;
  listSecrets: ReturnType<typeof mastersListSecretNames>;
  shareSecrets: ReturnType<typeof reviewShareSecretNames>;
  tilesBucket: string;
  tilesId: () => string;
  tilesChange: string | null;
  manifestBucket: string;
  manifestChange: string | null;
  mastersBucket: string;
  mastersId: () => string;
  mastersChange: string | null;
  /** The tags confirmed in B2 just before a key is issued over each bucket. */
  tags: { tiles: BucketTag; masters: BucketTag; review: BucketTag };
  /** The pairs an earlier run left half written, issued again from scratch. */
  pending: string[];
  /** Null when the federation has no review-tiles bucket: no share key. */
  reviewBucket: string | null;
  reviewId: () => string;
  reviewChange: string | null;
}

/**
 * Fisqua's B2 read key on the tiles bucket, R2 write token on the
 * manifest bucket, B2 list key on the masters bucket and, with a
 * review-tiles bucket, B2 share key on it, held as Worker secrets.
 */
export function fisquaKeyPlans(t: FisquaKeyTargets, held: HeldKeys, providers: Providers): KeyPlan[] {
  const { secrets } = t;
  const list = t.listSecrets;
  const tilesHeld = has(held.workerNames, secrets.deliveryReadKeyId, secrets.deliveryReadSecret);
  const manifestHeld = has(held.workerNames, secrets.manifestWriteKeyId, secrets.manifestWriteSecret);
  const mastersHeld = has(held.workerNames, list.keyId, list.secretKey);
  const reviewHeld = has(held.workerNames, t.shareSecrets.keyId, t.shareSecrets.secretKey);
  /**
   * A held pair is taken as held only when the account has a live key of
   * its name limited to its bucket with exactly its capabilities
   * (`liveKeyChange`); the secrets' values cannot be read back, so this
   * is as far as the pair can be checked.
   */
  const live = (name: string, bucket: string, id: () => string, capabilities: string[]) =>
    t.pending.includes(name) ? PENDING_PAIR_REASON : liveKeyChange(name, bucket, id, capabilities, held);
  const b2Discard = (k: { keyId: string }) => providers.b2!.deleteKey(k.keyId);
  return [
    {
      label: `B2 key, read, limited to ${t.tilesBucket} (Fisqua)`,
      name: t.keys.fisquaRead,
      held: tilesHeld,
      older: held.b2Keys.some((k) => k.keyName === t.keys.fisquaRead),
      reissue: t.tilesChange ?? (tilesHeld ? live(t.keys.fisquaRead, t.tilesBucket, t.tilesId, B2_READ_CAPABILITIES) : null),
      secretNames: [secrets.deliveryReadKeyId, secrets.deliveryReadSecret],
      discard: b2Discard,
      issue: async () => {
        await confirmTag(providers.b2!, t.tilesBucket, t.tags.tiles);
        return providers.b2!.createKey(t.keys.fisquaRead, B2_READ_CAPABILITIES, t.tilesId());
      },
      store: async (k, guard: SecretGuard) => {
        await guard(() => providers.worker!.put(secrets.deliveryReadKeyId, k.keyId));
        await guard(() => providers.worker!.put(secrets.deliveryReadSecret, k.secret));
      },
    },
    {
      label: `R2 token, object write, limited to ${t.manifestBucket} (Fisqua)`,
      name: t.keys.manifestWrite,
      held: manifestHeld,
      older: held.tokenNames.includes(t.keys.manifestWrite),
      // Cloudflare lists tokens by name only, so a held token is checked by name.
      reissue:
        t.manifestChange ??
        (manifestHeld && t.pending.includes(t.keys.manifestWrite)
          ? PENDING_PAIR_REASON
          : manifestHeld && providers.cloudflare && !held.tokenNames.includes(t.keys.manifestWrite)
            ? `no token named ${t.keys.manifestWrite} is in the Cloudflare account`
            : null),
      secretNames: [secrets.manifestWriteKeyId, secrets.manifestWriteSecret],
      issue: () => providers.cloudflare!.createR2WriteToken(t.keys.manifestWrite, t.manifestBucket),
      store: async (k, guard: SecretGuard) => {
        await guard(() => providers.worker!.put(secrets.manifestWriteKeyId, k.keyId));
        await guard(() => providers.worker!.put(secrets.manifestWriteSecret, k.secret));
      },
    },
    {
      label: `B2 key, list only, limited to ${t.mastersBucket} (Fisqua)`,
      name: t.keys.mastersList,
      held: mastersHeld,
      older: held.b2Keys.some((k) => k.keyName === t.keys.mastersList),
      reissue: t.mastersChange ?? (mastersHeld ? live(t.keys.mastersList, t.mastersBucket, t.mastersId, B2_LIST_CAPABILITIES) : null),
      secretNames: [list.keyId, list.secretKey],
      discard: b2Discard,
      issue: async () => {
        await confirmTag(providers.b2!, t.mastersBucket, t.tags.masters);
        return providers.b2!.createKey(t.keys.mastersList, B2_LIST_CAPABILITIES, t.mastersId());
      },
      store: async (k, guard: SecretGuard) => {
        await guard(() => providers.worker!.put(list.keyId, k.keyId));
        await guard(() => providers.worker!.put(list.secretKey, k.secret));
      },
    },
    ...(t.reviewBucket === null
      ? []
      : [
          {
            label: `B2 key, list, read and share, limited to ${t.reviewBucket} (Fisqua)`,
            name: t.keys.reviewShare,
            held: reviewHeld,
            older: held.b2Keys.some((k) => k.keyName === t.keys.reviewShare),
            reissue:
              t.reviewChange ??
              (reviewHeld ? live(t.keys.reviewShare, t.reviewBucket, t.reviewId, B2_SHARE_CAPABILITIES) : null),
            secretNames: [t.shareSecrets.keyId, t.shareSecrets.secretKey],
            discard: b2Discard,
            issue: async () => {
              await confirmTag(providers.b2!, t.reviewBucket!, t.tags.review);
              return providers.b2!.createKey(t.keys.reviewShare, B2_SHARE_CAPABILITIES, t.reviewId());
            },
            store: async (k: { keyId: string; secret: string }, guard: SecretGuard) => {
              await guard(() => providers.worker!.put(t.shareSecrets.keyId, k.keyId));
              await guard(() => providers.worker!.put(t.shareSecrets.secretKey, k.secret));
            },
          } satisfies KeyPlan,
        ]),
  ];
}

/**
 * Why a held Fisqua key must be issued again although its bucket is
 * unchanged: no key of its name in the B2 account is limited to the
 * bucket with exactly the capabilities wanted (`limitChange`). Null when
 * one is, or when the bucket's id is not known yet (a dry run that would
 * create the bucket). Keys of one name limited differently stop the
 * command, as for the runner's keys.
 */
function liveKeyChange(
  name: string,
  bucket: string,
  id: () => string,
  capabilities: string[],
  held: HeldKeys,
): string | null {
  let bucketId: string | null = null;
  try {
    bucketId = id();
  } catch (err) {
    if (!(err instanceof ProvisionStop)) throw err;
  }
  return limitChange(name, { bucket, bucketId, prefix: "" }, held.b2Keys, capabilities);
}

/** Prints each Worker secret: set already, to be set, or to be replaced. */
function logWorkerSecrets(
  names: string[],
  held: HeldKeys,
  replaced: string[],
  apply: boolean,
  log: Log,
): void {
  for (const name of names) {
    if (held.workerNames === null) {
      log(`  [unchecked] ${name}`);
    } else if (!held.workerNames.includes(name)) {
      log(`  [${apply ? "set" : "would set"}] ${name}`);
    } else if (replaced.includes(name)) {
      log(`  [${apply ? "replaced" : "would replace"}] ${name}`);
    } else {
      log(`  [exists] ${name}`);
    }
  }
}

/** Issues Fisqua's keys and prints the Worker secrets that hold them. */
async function fisquaKeys(
  federation: FederationRow,
  keys: FederationKeyNames,
  values: DestinationValues,
  ids: { tiles: () => string; masters: () => string; review: () => string },
  tags: FisquaKeyTargets["tags"],
  providers: Providers,
  apply: boolean,
  log: Log,
): Promise<void> {
  const secrets = workerSecretNames(values.storage_secret_prefix);
  const listSecrets = mastersListSecretNames(values.storage_secret_prefix);
  const shareSecrets = reviewShareSecretNames(values.storage_secret_prefix);
  const reviewBucket = recordValue(values, REVIEW_TILES_COLUMN);
  const held = await heldKeys(providers, null);
  const scope = `federation:${federation.id}`;
  const pending = await providers.d1.pendingPairs(scope);
  // Secrets set by an earlier run hold keys limited to the buckets it
  // recorded; a changed bucket needs its key issued again.
  const targets: FisquaKeyTargets = {
    keys,
    secrets,
    listSecrets,
    shareSecrets,
    tilesBucket: values.pipeline_tiles_bucket,
    tilesId: ids.tiles,
    tilesChange: bucketChange("tiles bucket", federation.pipeline_tiles_bucket, values.pipeline_tiles_bucket),
    manifestBucket: values.manifest_bucket,
    manifestChange: bucketChange("manifest bucket", federation.manifest_bucket, values.manifest_bucket),
    mastersBucket: values.pipeline_masters_bucket,
    mastersId: ids.masters,
    mastersChange: bucketChange("masters bucket", federation.pipeline_masters_bucket, values.pipeline_masters_bucket),
    tags,
    pending,
    reviewBucket,
    reviewId: ids.review,
    reviewChange:
      reviewBucket === null
        ? null
        : bucketChange("review-tiles bucket", federation.pipeline_review_tiles_bucket ?? null, reviewBucket),
  };
  const plans = fisquaKeyPlans(targets, held, providers);
  await issueKeys(plans, apply, log, providers.lease ? pairJournal(providers, providers.lease) : null);
  log("");
  log("3. Worker secrets");
  logWorkerSecrets(
    [
      ...Object.values(secrets),
      listSecrets.keyId,
      listSecrets.secretKey,
      ...(reviewBucket === null ? [] : [shareSecrets.keyId, shareSecrets.secretKey]),
    ],
    held,
    // Every key the plans issue again, for whatever reason, replaces its secrets.
    replacedSecretNames(plans, held.workerNames),
    apply,
    log,
  );
}

/**
 * The columns a planned record changes whose change pending work
 * refuses: every changed column but the review-tiles bucket where the
 * record names none yet, since no run's destination names it.
 */
function pendingSensitiveChanges(federation: FederationRow, values: DestinationValues): string[] {
  return RECORD_COLUMNS.filter((c) => (federation[c] ?? null) !== recordValue(values, c)).filter(
    (c) => c !== REVIEW_TILES_COLUMN || (federation[c] ?? null) !== null,
  );
}

/** Checks a planned record against pending work and the other federations, then writes it. */
async function recordDestination(
  federation: FederationRow,
  planned: DestinationValues,
  providers: Providers,
  apply: boolean,
  log: Log,
): Promise<void> {
  // Values without the review-tiles column keep what the record holds,
  // as `destinationStatement` leaves it out.
  const values: DestinationValues = {
    ...planned,
    [REVIEW_TILES_COLUMN]: planned[REVIEW_TILES_COLUMN] === undefined ? (federation[REVIEW_TILES_COLUMN] ?? null) : planned[REVIEW_TILES_COLUMN],
  };
  checkDestinationValues(values);
  const changed = RECORD_COLUMNS.filter((c) => (federation[c] ?? null) !== recordValue(values, c));
  for (const c of RECORD_COLUMNS) {
    const recorded = federation[c] ?? null;
    const wanted = recordValue(values, c);
    log(`  ${c}: ${recorded === wanted ? "unchanged" : `${recorded ?? "(empty)"} -> ${wanted ?? "(empty)"}`}`);
  }
  if (changed.length === 0) {
    log("  [exists] the federation record already holds this destination");
    return;
  }
  if (pendingSensitiveChanges(federation, values).length > 0) {
    await refuseWhilePending({ federationId: federation.id }, providers, PENDING);
  }
  await refuseCollisions(federation, values, providers);
  const moved = (
    [
      ["pipeline_tiles_bucket", "tiles bucket"],
      ["pipeline_masters_bucket", "masters bucket"],
    ] as const
  )
    .filter(([c]) => federation[c] !== null && federation[c] !== values[c])
    .map(([, what]) => what);
  if (moved.length > 0) {
    const tenants = await providers.d1.tenantsOf(federation.id);
    if (tenants.length > 0) {
      log(
        `  [note] the runner keys of ${tenants.join(", ")} are limited to the old ${moved.join(" and ")}; ` +
          "run provision-tenant-storage for each once the record is written",
      );
    }
  }
  if (!apply) {
    log(`  [write] would write ${changed.length} column(s) to the federation record`);
    return;
  }
  // Fenced by the lock and compared with the record as this run read it,
  // in one statement: a run whose lock is lost, or whose snapshot another
  // run has since changed, writes nothing.
  if (!providers.lease) throw new ProvisionStop("The federation record is written only by a run that holds the provisioning lock");
  const written = await providers.d1.writeDestination(federation.id, values, federation, {
    scope: providers.lease.scope,
    token: providers.lease.token,
    now: providers.now(),
  });
  if (!written) {
    throw new ProvisionStop(
      `The federation record of ${federation.slug} was not written: this run's provisioning lock was lost, or another run ` +
        "changed the record since this run read it. Its buckets, keys and secrets may already reflect this run; " +
        "run the command again, which reads the record afresh",
    );
  }
  log(`  [write] wrote ${changed.length} column(s) to the federation record`);
}

/**
 * Sets up a new federation's storage and records it. Returns the record
 * written (or planned).
 */
export async function provisionFederationStorage(
  options: ProvisionFederationOptions,
  providers: Providers,
  log: Log,
): Promise<DestinationValues> {
  // The checks that read nothing come first, then the lock.
  if (options.target === "local") {
    throw new ProvisionStop("Provisioning creates storage in the accounts; use --target staging or production");
  }
  federationStorageNames(options.slug, options.domain, options.target);
  if (options.mastersBucket != null && !BUCKET_PATTERN.test(options.mastersBucket)) {
    throw new ProvisionStop(`Not a bucket name: ${options.mastersBucket}`);
  }
  const federation = await loadFederation(providers, options.slug);
  // One applied run at a time per federation: see `withProvisioningLock`.
  return withProvisioningLock(providers, `federation:${federation.id}`, options.apply, (locked) =>
    provisionFederation(options, locked, log),
  );
}

async function provisionFederation(
  options: ProvisionFederationOptions,
  providers: Providers,
  log: Log,
): Promise<DestinationValues> {
  const { apply } = options;
  if (options.target === "local") {
    throw new ProvisionStop("Provisioning creates storage in the accounts; use --target staging or production");
  }
  const names = federationStorageNames(options.slug, options.domain, options.target);
  const adoptedMasters = options.mastersBucket ?? null;
  if (adoptedMasters !== null && !BUCKET_PATTERN.test(adoptedMasters)) {
    throw new ProvisionStop(`Not a bucket name: ${adoptedMasters}`);
  }
  const federation = await loadFederation(providers, options.slug);
  // The recorded masters bucket changes only with `--masters-bucket`.
  // Without the flag, a record that names one keeps it, and
  // `{slug}-masters` is never planned in its place.
  const recordedMasters = federation.pipeline_masters_bucket ?? null;
  const keptMasters =
    adoptedMasters === null && recordedMasters !== null && recordedMasters !== names.mastersBucket ? recordedMasters : null;
  // A bucket named by the flag or kept from the record is found, never created.
  const existingMasters = adoptedMasters ?? keptMasters;
  const mastersBucket = existingMasters ?? names.mastersBucket;
  // Checked first as well as before the record is written, so nothing is
  // created for a federation whose record cannot change yet. A complete
  // record that already holds every value this run would write, the two
  // account endpoints included, can at most gain the review-tiles bucket,
  // which pending work does not refuse. Every record column is compared:
  // the names, and the endpoints of the B2 and Cloudflare accounts whose
  // credentials the run holds (credentials for another account would
  // replace Fisqua's keys with keys the record's endpoints do not serve).
  // An endpoint that cannot be read (no credentials) does not match.
  const named: Record<Exclude<(typeof RECORD_COLUMNS)[number], typeof REVIEW_TILES_COLUMN>, string | null> = {
    pipeline_delivery_endpoint: null,
    pipeline_tiles_bucket: names.tilesBucket,
    pipeline_masters_bucket: mastersBucket,
    pipeline_image_base_url: names.imageBaseUrl,
    manifest_endpoint: providers.cloudflare?.s3Endpoint ?? null,
    manifest_bucket: names.manifestBucket,
    manifest_base_url: names.manifestBaseUrl,
    storage_secret_prefix: names.secretPrefix,
  };
  const matches = () =>
    (Object.keys(named) as Array<keyof typeof named>).every((c) => named[c] !== null && federation[c] === named[c]);
  const reviewFits = [null, names.reviewTilesBucket].includes(federation.pipeline_review_tiles_bucket ?? null);
  let onlyAddsReview = false;
  if (isRecordComplete(federation) && reviewFits) {
    // The B2 endpoint is read only for a record that could be exempt.
    named.pipeline_delivery_endpoint = providers.b2 ? (await providers.b2.account()).s3ApiUrl.replace(/\/+$/, "") : null;
    onlyAddsReview = matches();
  }
  if (!onlyAddsReview) await refuseWhilePending({ federationId: federation.id }, providers, PENDING);
  // Every column a unique index covers is known from the names, so a
  // collision stops the command before a bucket, host, key or secret is
  // touched.
  await refuseCollisions(
    federation,
    {
      pipeline_tiles_bucket: names.tilesBucket,
      pipeline_masters_bucket: mastersBucket,
      manifest_bucket: names.manifestBucket,
      manifest_base_url: names.manifestBaseUrl,
      storage_secret_prefix: names.secretPrefix,
      pipeline_review_tiles_bucket: names.reviewTilesBucket,
    },
    providers,
  );
  await refuseBucketAliases(
    federation.id,
    {
      pipeline_tiles_bucket: names.tilesBucket,
      pipeline_masters_bucket: mastersBucket,
      pipeline_review_tiles_bucket: names.reviewTilesBucket,
      manifest_bucket: names.manifestBucket,
    },
    workingBucketFor(options.target),
    providers,
    federation,
  );
  const { b2, cloudflare, worker } = providers;
  const reviewCors = reviewTilesCorsRules(options.target);
  const reviewDescription = `private, no lifecycle rule, CORS GET/HEAD from ${reviewTilesOrigins(options.target).join(" and ")}`;

  log(`Storage for federation ${options.slug} (${federation.id}), target ${options.target}${apply ? "" : ", dry run"}`);
  log("");
  log("Names");
  log(`  tiles bucket (B2, public):    ${names.tilesBucket}`);
  log(
    `  masters bucket (B2, private): ${mastersBucket}` +
      `${adoptedMasters ? " (existing, adopted)" : keptMasters ? " (recorded, kept; --masters-bucket changes it)" : ""}`,
  );
  log(`  review-tiles bucket (B2, private): ${names.reviewTilesBucket}`);
  log(`  manifest bucket (R2):         ${names.manifestBucket}`);
  log(`  tiles host:                   ${names.tilesHost}`);
  log(`  manifest host:                ${names.manifestHost}`);
  log(`  Worker secret prefix:         ${names.secretPrefix}`);
  log("  Each tenant's output goes under its slug in these buckets; provision-tenant-storage issues its keys.");
  if (apply) {
    const missing = [!b2 && "B2", !cloudflare && "Cloudflare", !worker && "Worker secrets"].filter(Boolean);
    if (missing.length > 0) throw new ProvisionStop(`--apply needs credentials for: ${missing.join(", ")}`);
  }

  log("");
  log("1. Buckets and hosts");
  let tilesBucketId: string | null = null;
  let mastersBucketId: string | null = null;
  let reviewBucketId: string | null = null;
  let s3ApiUrl: string | null = null;
  let downloadHost: string | null = null;
  const tagFor = (role: BucketRole): BucketTag => ({ role, env: options.target as "staging" | "production", federation: options.slug });
  // A bucket the record moves away from keeps the tag of its role, so no
  // later run can give it another role.
  const outgoing = outgoingBuckets(federation, { tiles: names.tilesBucket, masters: mastersBucket, review: names.reviewTilesBucket });
  if (!b2) {
    log(`  [unchecked] B2 buckets ${names.tilesBucket}, ${mastersBucket} and ${names.reviewTilesBucket} (no B2 credentials)`);
  } else {
    const account = await b2.account();
    s3ApiUrl = account.s3ApiUrl.replace(/\/+$/, "");
    downloadHost = hostOf(account.downloadUrl);
    // Every planned bucket's tag, and an adopted or kept masters bucket,
    // is checked before anything is created: staging and production
    // share the B2 account, so a bucket's role is read from its tag.
    const existingTiles = await b2.findBucket(names.tilesBucket);
    if (existingTiles) refuseTagConflict(existingTiles, names.tilesBucket, tagFor("tiles"));
    const adopted = await b2.findBucket(mastersBucket);
    if (adopted) refuseTagConflict(adopted, mastersBucket, tagFor("masters"));
    await refuseOutgoingConflicts(b2, outgoing, tagFor);
    if (existingMasters !== null) {
      const how = adoptedMasters !== null ? "it is adopted, not created" : "it is the recorded one, kept, not created";
      if (!adopted) {
        throw new ProvisionStop(`The masters bucket ${existingMasters} is not in the B2 account; ${how}`);
      }
      if (adopted.bucketType !== "allPrivate") {
        throw new ProvisionStop(`The masters bucket ${existingMasters} is ${adopted.bucketType}, not allPrivate`);
      }
    }
    // So is an existing review-tiles bucket.
    await refuseReviewBucket(b2, await b2.findBucket(names.reviewTilesBucket), names.reviewTilesBucket, tagFor("review-tiles"));
    tilesBucketId = await ensureB2Bucket(
      b2, names.tilesBucket, "allPublic", B2_CORS_RULES, "public, CORS GET/HEAD from any origin", apply, log, tagFor("tiles"),
    );
    if (existingMasters !== null && adopted) {
      mastersBucketId = adopted.bucketId;
      log(`  [exists] B2 bucket ${mastersBucket}, private (${adoptedMasters !== null ? "adopted" : "recorded, kept"})`);
      await tagBucket(b2, mastersBucket, tagFor("masters"), apply, log);
    } else {
      mastersBucketId = await ensureB2Bucket(
        b2, names.mastersBucket, "allPrivate", [], "private, no CORS rule, no host", apply, log, tagFor("masters"),
      );
    }
    reviewBucketId = await ensureB2Bucket(
      b2, names.reviewTilesBucket, "allPrivate", reviewCors, reviewDescription, apply, log, tagFor("review-tiles"),
    );
    await tagOutgoing(b2, outgoing, tagFor, apply, log);
  }

  if (!cloudflare) {
    log(`  [unchecked] R2 bucket ${names.manifestBucket}, ${names.manifestHost}, ${names.tilesHost} (no Cloudflare credentials)`);
  } else {
    const zoneId = await cloudflare.findZone(options.domain);
    if (!zoneId) throw new ProvisionStop(`The zone ${options.domain} is not in the Cloudflare account`);
    const manifestBucketExisted = await cloudflare.r2BucketExists(names.manifestBucket);
    if (manifestBucketExisted) {
      log(`  [exists] R2 bucket ${names.manifestBucket}`);
    } else {
      if (apply) await cloudflare.createR2Bucket(names.manifestBucket);
      log(`  [create] ${apply ? "" : "would create "}R2 bucket ${names.manifestBucket}`);
    }
    const readable = apply || manifestBucketExisted;
    const cors = readable ? await cloudflare.r2Cors(names.manifestBucket) : null;
    if (JSON.stringify(cors) === JSON.stringify(R2_CORS_RULES)) {
      log(`  [exists] CORS rule on ${names.manifestBucket}`);
    } else {
      if (apply) await cloudflare.putR2Cors(names.manifestBucket, R2_CORS_RULES);
      log(`  [update] ${apply ? "set" : "would set"} CORS GET/HEAD from any origin on ${names.manifestBucket}`);
    }
    const domains = readable ? await cloudflare.r2CustomDomains(names.manifestBucket) : [];
    if (domains.includes(names.manifestHost)) {
      log(`  [exists] ${names.manifestHost} on ${names.manifestBucket}`);
    } else {
      if (apply) await cloudflare.addR2CustomDomain(names.manifestBucket, names.manifestHost, zoneId);
      log(`  [create] ${apply ? "attached" : "would attach"} ${names.manifestHost} to ${names.manifestBucket}`);
    }

    const target = downloadHost ?? "(the B2 download host)";
    const record = await cloudflare.findCname(zoneId, names.tilesHost);
    if (record) {
      if (downloadHost && record.content !== downloadHost) {
        throw new ProvisionStop(`${names.tilesHost} already points at ${record.content}, not ${downloadHost}`);
      }
      if (!record.proxied) throw new ProvisionStop(`${names.tilesHost} exists but is not proxied`);
      log(`  [exists] ${names.tilesHost}, proxied CNAME to ${record.content}`);
    } else {
      if (apply) {
        if (!downloadHost) throw new ProvisionStop("The B2 download host is unknown");
        await cloudflare.createCname(zoneId, names.tilesHost, downloadHost);
      }
      log(`  [create] ${apply ? "" : "would create "}proxied CNAME ${names.tilesHost} -> ${target}`);
    }
    const rules = await cloudflare.transformRules(zoneId);
    const wanted = transformRuleFor(names.tilesHost, names.tilesBucket);
    const same = rules.find((r) => r.expression === wanted.expression);
    if (same && JSON.stringify(same.action_parameters) === JSON.stringify(wanted.action_parameters)) {
      log(`  [exists] Transform Rule adding /file/${names.tilesBucket} on ${names.tilesHost}`);
    } else if (same) {
      throw new ProvisionStop(`A Transform Rule for ${names.tilesHost} exists with another rewrite; it is left for a person`);
    } else {
      if (apply) await cloudflare.putTransformRules(zoneId, [...rules, wanted]);
      log(`  [create] ${apply ? "" : "would add "}Transform Rule adding /file/${names.tilesBucket} on ${names.tilesHost}`);
    }
  }

  const values: DestinationValues = {
    pipeline_delivery_endpoint: s3ApiUrl ?? "",
    pipeline_tiles_bucket: names.tilesBucket,
    pipeline_masters_bucket: mastersBucket,
    pipeline_image_base_url: names.imageBaseUrl,
    manifest_endpoint: cloudflare?.s3Endpoint ?? "",
    manifest_bucket: names.manifestBucket,
    manifest_base_url: names.manifestBaseUrl,
    storage_secret_prefix: names.secretPrefix,
    pipeline_review_tiles_bucket: names.reviewTilesBucket,
  };

  log("");
  log("2. Fisqua's keys");
  await fisquaKeys(
    federation,
    names.keys,
    values,
    {
      tiles: () => idOf(tilesBucketId, names.tilesBucket),
      masters: () => idOf(mastersBucketId, mastersBucket),
      review: () => idOf(reviewBucketId, names.reviewTilesBucket),
    },
    { tiles: tagFor("tiles"), masters: tagFor("masters"), review: tagFor("review-tiles") },
    providers,
    apply,
    log,
  );

  log("");
  log("4. Federation record");
  if (!s3ApiUrl || !values.manifest_endpoint) {
    log("  [unchecked] the endpoints come from the accounts; the record is written only with both");
    return values;
  }
  await recordDestination(federation, values, providers, apply, log);
  return values;
}

/**
 * Records storage that already exists and issues Fisqua's keys for it.
 * Creates no bucket or host but the review-tiles bucket.
 */
export async function adoptFederationStorage(
  options: AdoptFederationOptions,
  providers: Providers,
  log: Log,
): Promise<void> {
  checkDestinationValues(options.values);
  if (!BUCKET_PATTERN.test(options.values.pipeline_masters_bucket)) {
    throw new ProvisionStop(`Not a bucket name: ${options.values.pipeline_masters_bucket}`);
  }
  if (!SLUG_PATTERN.test(options.slug)) throw new ProvisionStop(`Not a federation slug: ${options.slug}`);
  const federation = await loadFederation(providers, options.slug);
  return withProvisioningLock(providers, `federation:${federation.id}`, options.apply, (locked) =>
    adoptFederation(options, locked, log),
  );
}

async function adoptFederation(options: AdoptFederationOptions, providers: Providers, log: Log): Promise<void> {
  const { apply } = options;
  const local = options.target === "local";
  const federation = await loadFederation(providers, options.slug);
  const { b2, cloudflare, worker } = providers;
  const keys = federationKeyNames(options.slug, options.target);
  // No adopted storage had a review-tiles bucket, so it takes the
  // provisioned name; on local the record keeps what it names.
  const values: DestinationValues = {
    ...options.values,
    pipeline_review_tiles_bucket: local
      ? (federation.pipeline_review_tiles_bucket ?? null)
      : reviewTilesBucketFor(options.slug, options.target),
  };
  const reviewBucket = recordValue(values, REVIEW_TILES_COLUMN);
  if (pendingSensitiveChanges(federation, values).length > 0) {
    // Before any key is issued, so nothing is made for a record that cannot change yet.
    await refuseWhilePending({ federationId: federation.id }, providers, PENDING);
  }
  // Before any key is issued or secret set: with another federation's
  // prefix, setting the secrets would replace that federation's keys.
  await refuseCollisions(federation, values, providers);
  await refuseBucketAliases(federation.id, values, local ? null : workingBucketFor(options.target), providers, federation);
  log(`Adopting storage for federation ${options.slug} (${federation.id}), target ${options.target}${apply ? "" : ", dry run"}`);
  if (local) {
    log("No bucket, host or key is made on the local target; only the federation record is written.");
  } else {
    log(`No bucket or host is created but the review-tiles bucket ${reviewBucket}. Fisqua's four keys are issued where their Worker secrets are not set.`);
    log("Each tenant's new output goes under its slug in these buckets; provision-tenant-storage issues its keys.");
  }
  if (apply && !local) {
    const missing = [!b2 && "B2", !cloudflare && "Cloudflare", !worker && "Worker secrets"].filter(Boolean);
    if (missing.length > 0) throw new ProvisionStop(`--apply needs credentials for: ${missing.join(", ")}`);
  }

  log("");
  log("1. Existing buckets");
  let tilesBucketId: string | null = null;
  let mastersBucketId: string | null = null;
  let reviewBucketId: string | null = null;
  let adoptedTiles: B2Bucket | null = null;
  let adoptedMasters: B2Bucket | null = null;
  const outgoing = local
    ? []
    : outgoingBuckets(federation, {
        tiles: values.pipeline_tiles_bucket,
        masters: values.pipeline_masters_bucket,
        review: reviewBucket,
      });
  // No bucket is tagged on the local target, which makes nothing in B2.
  const adoptTag = local
    ? null
    : (role: BucketRole): BucketTag => ({ role, env: options.target as "staging" | "production", federation: options.slug });
  if (!b2) {
    log(`  [unchecked] B2 buckets ${values.pipeline_tiles_bucket} and ${values.pipeline_masters_bucket} (no B2 credentials)`);
  } else {
    const account = await b2.account();
    const s3ApiUrl = account.s3ApiUrl.replace(/\/+$/, "");
    if (s3ApiUrl !== values.pipeline_delivery_endpoint) {
      throw new ProvisionStop(`--tiles-endpoint ${values.pipeline_delivery_endpoint} is not the B2 account's S3 endpoint ${s3ApiUrl}`);
    }
    const bucket = await b2.findBucket(values.pipeline_tiles_bucket);
    if (!bucket) throw new ProvisionStop(`The B2 bucket ${values.pipeline_tiles_bucket} is not in the B2 account`);
    if (adoptTag) refuseTagConflict(bucket, values.pipeline_tiles_bucket, adoptTag("tiles"));
    adoptedTiles = bucket;
    tilesBucketId = bucket.bucketId;
    log(`  [exists] B2 bucket ${values.pipeline_tiles_bucket}`);
    const masters = await b2.findBucket(values.pipeline_masters_bucket);
    if (!masters) {
      throw new ProvisionStop(
        `The masters bucket ${values.pipeline_masters_bucket} is not in the B2 account; adoption does not create it`,
      );
    }
    if (masters.bucketType !== "allPrivate") {
      throw new ProvisionStop(`The masters bucket ${values.pipeline_masters_bucket} is ${masters.bucketType}, not allPrivate`);
    }
    if (adoptTag) refuseTagConflict(masters, values.pipeline_masters_bucket, adoptTag("masters"));
    if (adoptTag) await refuseOutgoingConflicts(b2, outgoing, adoptTag);
    adoptedMasters = masters;
    mastersBucketId = masters.bucketId;
    log(`  [exists] B2 masters bucket ${values.pipeline_masters_bucket}, private`);
  }
  if (!cloudflare) {
    log(`  [unchecked] R2 bucket ${values.manifest_bucket} (no Cloudflare credentials)`);
  } else {
    if (cloudflare.s3Endpoint !== values.manifest_endpoint) {
      throw new ProvisionStop(
        `--manifest-endpoint ${values.manifest_endpoint} is not the Cloudflare account's R2 endpoint ${cloudflare.s3Endpoint}`,
      );
    }
    if (!(await cloudflare.r2BucketExists(values.manifest_bucket))) {
      throw new ProvisionStop(`The R2 bucket ${values.manifest_bucket} is not in the Cloudflare account`);
    }
    log(`  [exists] R2 bucket ${values.manifest_bucket}`);
  }

  // After every existing bucket is checked, so a wrong flag leaves nothing made.
  if (!local && reviewBucket !== null) {
    if (!b2) {
      log(`  [unchecked] B2 bucket ${reviewBucket} (no B2 credentials)`);
    } else {
      await refuseReviewBucket(b2, await b2.findBucket(reviewBucket), reviewBucket, adoptTag!("review-tiles"));
      // The existing buckets are tagged only now, after every check.
      if (adoptedTiles) await tagBucket(b2, values.pipeline_tiles_bucket, adoptTag!("tiles"), apply, log);
      if (adoptedMasters) await tagBucket(b2, values.pipeline_masters_bucket, adoptTag!("masters"), apply, log);
      await tagOutgoing(b2, outgoing, adoptTag!, apply, log);
      reviewBucketId = await ensureB2Bucket(
        b2,
        reviewBucket,
        "allPrivate",
        reviewTilesCorsRules(options.target as "staging" | "production"),
        `private, no lifecycle rule, CORS GET/HEAD from ${reviewTilesOrigins(options.target as "staging" | "production").join(" and ")}`,
        apply,
        log,
        adoptTag!("review-tiles"),
      );
    }
  }

  log("");
  log("2. Fisqua's keys");
  if (local) {
    log("  [unchecked] Worker secrets for local development go in .dev.vars, by hand; no key is issued");
  } else {
    await fisquaKeys(
      federation,
      keys,
      values,
      {
        tiles: () => idOf(tilesBucketId, values.pipeline_tiles_bucket),
        masters: () => idOf(mastersBucketId, values.pipeline_masters_bucket),
        review: () => idOf(reviewBucketId, reviewBucket ?? ""),
      },
      { tiles: adoptTag!("tiles"), masters: adoptTag!("masters"), review: adoptTag!("review-tiles") },
      providers,
      apply,
      log,
    );
  }

  log("");
  log(local ? "3. Federation record" : "4. Federation record");
  await recordDestination(federation, values, providers, apply, log);
}

// @version v0.8.0
