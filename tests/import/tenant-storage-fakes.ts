/**
 * Tests — in-memory providers for the storage commands
 *
 * This helper module deals with standing in for every account the
 * federation and tenant storage commands touch: Backblaze B2, Cloudflare
 * (R2, DNS, Transform Rules, API tokens), the runner's GitHub repository,
 * the Worker's secrets and the catalogue database. `fakeWorld(options)`
 * returns one `Providers` value whose clients read and change plain
 * in-memory state, the state itself so a test can look at it, and a
 * call log. Keys and tokens it issues carry recognisable fake values,
 * so a test can check that none of them reaches the command's output.
 * The B2 keys it holds keep the bucket and name prefix each is limited
 * to and its capabilities, as `b2_list_keys` reports them, and are
 * listed with an id from their position (`FAKELISTEDKEY{n}`) unless a
 * test gives one; with `listIssuedIds`, a key the fake issues is listed
 * under the id it was issued with, so a command can find it again by id.
 * Files a test puts in `world.b2.files`, by bucket id, are the bucket's
 * versions, oldest first: a name may appear more than once, and an entry
 * with `action: "hide"` is a hide marker, one with `action: "start"` an
 * unfinished large file. `listFiles` returns, under a
 * prefix, each name's newest entry unless it is a hide marker, as
 * `b2_list_file_names` does; `listFileDetails` adds each file's id
 * (`FAKEFILE-{name}` unless a test gives one) and its SHA1, read from
 * `contentSha1` and `fileInfo` as `sha1Of` reads B2's listing.
 * `listFolders` returns the folders those names make directly under a
 * prefix, as B2 does with the delimiter `/`.
 * `listFileVersions` returns every entry, hide markers included, each
 * name's newest first; `hasFileVersions` says whether a bucket has any
 * entry at all. `copyFile` adds a file to the destination bucket
 * with the source's size, SHA1 and file info, after `onCopy` when a test
 * gives one (to stand in for a copy that comes out different), and then
 * calls `afterCopy` when a test gives one (to stand in for another
 * writer at the same key).
 *
 * Buckets keep their bucket info (the role tags among it) and a
 * revision (1 until the first update); an update replaces the CORS
 * rules or the bucket info only when it sends them, raises the
 * revision, and is refused with `BucketRevisionConflictError` when it
 * names a revision the bucket no longer has, as `b2_update_bucket` does
 * with `ifRevisionIs`. `beforeUpdateBucket` runs at the start of every
 * update, so a test can interleave another run there.
 *
 * Pairs marked as being written live in `world.d1.pendingPairs`, and
 * `deleteKey` removes a key the fake issued, by its id.
 *
 * Provisioning locks live in `world.d1.locks`, taken and released as the
 * `provisioning_locks` statements do: an expired lock is cleared, a free
 * scope is taken, and the lock as it stands is returned.
 *
 * The database starts with one federation (`acme` by default) and one
 * tenant in it (`sbmal`, id `FAKE_TENANT_ID`), neither with storage.
 * The B2 account starts with one private bucket, `FAKE_WORKING_BUCKET`,
 * standing in for the shared working bucket the tenant step expects to
 * find.
 *
 * Every value here is a test value: no real account, endpoint, bucket,
 * zone, repository or key.
 *
 * @version v0.8.0
 */
import {
  RECORD_COLUMNS,
  BucketNameTakenError,
  BucketRevisionConflictError,
  sha1Of,
  type B2Api,
  type B2Bucket,
  type B2FileInfo,
  type CloudflareApi,
  type D1Api,
  type FederationRow,
  type GitHubApi,
  type PendingScope,
  type Providers,
  type TenantRow,
  type TransformRule,
  type WorkerSecretsApi,
} from "../../scripts/lib/tenant-storage";

export const FAKE_TENANT_ID = "11111111-aaaa-4aaa-8aaa-111111111111";
export const FAKE_FEDERATION_ID = "f1111111-aaaa-4aaa-8aaa-111111111111";
export const FAKE_B2_S3 = "https://s3.us-west-000.backblazeb2.com";
export const FAKE_B2_DOWNLOAD = "https://f000.backblazeb2.com";
export const FAKE_R2_S3 = "https://fakeaccount.r2.cloudflarestorage.com";
export const FAKE_WORKING_BUCKET = "fake-working-bucket";
export const FAKE_WORKING_BUCKET_ID = "bucket-working";

/** A file in the fake B2 account, with what `b2_list_file_names` would report about it. */
export interface FakeB2File extends B2FileInfo {
  fileId?: string;
  /** A hide marker; an upload when absent. */
  action?: "hide" | "start";
  contentSha1?: string;
  fileInfo?: Record<string, string>;
}

export interface World {
  b2: {
    buckets: Map<string, B2Bucket>;
    taken: Set<string>;
    keys: Array<{ name: string; bucketId: string; capabilities: string[]; namePrefix?: string; keyId?: string }>;
    /** Files by bucket id, as `listFiles` reports them. */
    files: Map<string, FakeB2File[]>;
    /** Each key the fake issued, by the id it was issued with, for `deleteKey`. */
    issuedKeys: Map<string, World["b2"]["keys"][number]>;
  };
  cf: {
    zones: Map<string, string>;
    r2: Set<string>;
    cors: Map<string, unknown[]>;
    domains: Map<string, string[]>;
    cnames: Map<string, { content: string; proxied: boolean }>;
    rules: Map<string, TransformRule[]>;
    tokens: Array<{ name: string; bucket: string }>;
  };
  gh: { environments: Set<string>; secrets: Map<string, Map<string, string>>; variables: Map<string, string> };
  worker: Map<string, string>;
  d1: {
    tenants: TenantRow[];
    federations: FederationRow[];
    openRuns: number;
    unpublishedVolumes: number;
    writes: number;
    /** Every scope pending work was asked for. */
    pendingScopes: PendingScope[];
    /** The provisioning locks, by scope, as `provisioning_locks` holds them. */
    locks: Map<string, { holder: string; token: string; startedAt: number; expiresAt: number }>;
    /**
     * The pairs marked as being written, as `provisioning_pending_pairs`
     * holds them: `{scope} {pair}` to the token of the run that marked it.
     */
    pendingPairs: Map<string, string>;
  };
  calls: string[];
  issued: string[];
}

export interface FakeOptions {
  /** The federation's slug; `acme` by default. */
  federation?: string;
  /** The tenant's slug; `sbmal` by default. */
  tenant?: string;
  tenantId?: string;
  failOn?: (call: string) => boolean;
  /** List each issued key under the id it was issued with. */
  listIssuedIds?: boolean;
  /** Changes the file a copy makes, before it is stored. */
  onCopy?: (file: FakeB2File) => FakeB2File;
  /** Runs after a copy is stored, with the destination bucket's files. */
  afterCopy?: (file: FakeB2File, files: FakeB2File[]) => void;
  /**
   * Runs at the start of every bucket update, before its revision is
   * compared, so a test can let another run change the bucket in between
   * (the paused interleaving of two provisioning runs).
   */
  beforeUpdateBucket?: (bucketId: string) => Promise<void> | void;
}

export function emptyFederation(id: string, slug: string): FederationRow {
  return {
    id,
    slug,
    pipeline_delivery_endpoint: null,
    pipeline_tiles_bucket: null,
    pipeline_masters_bucket: null,
    pipeline_image_base_url: null,
    manifest_endpoint: null,
    manifest_bucket: null,
    manifest_base_url: null,
    storage_secret_prefix: null,
    pipeline_review_tiles_bucket: null,
  };
}

/**
 * A CORS rule as `b2_list_buckets` reports it: keys in another order,
 * lists sent empty returned as null, lists in another order.
 */
function asB2Reports(rule: unknown): unknown {
  const r = rule as Record<string, any>;
  const reversed = (l: unknown[] | undefined) => (l && l.length ? [...l].reverse() : null);
  return {
    maxAgeSeconds: r.maxAgeSeconds,
    exposeHeaders: reversed(r.exposeHeaders),
    allowedOperations: reversed(r.allowedOperations),
    allowedHeaders: reversed(r.allowedHeaders),
    allowedOrigins: reversed(r.allowedOrigins),
    corsRuleName: r.corsRuleName,
  };
}

export function fakeWorld(options: FakeOptions = {}): { world: World; providers: Providers } {
  const federationSlug = options.federation ?? "acme";
  const world: World = {
    b2: {
      buckets: new Map([
        [
          FAKE_WORKING_BUCKET,
          { bucketId: FAKE_WORKING_BUCKET_ID, bucketName: FAKE_WORKING_BUCKET, bucketType: "allPrivate", corsRules: [] },
        ],
      ]),
      taken: new Set(),
      keys: [],
      files: new Map(),
      issuedKeys: new Map(),
    },
    cf: {
      zones: new Map([["acme.example.test", "zone-acme"]]),
      r2: new Set(),
      cors: new Map(),
      domains: new Map(),
      cnames: new Map(),
      rules: new Map([["zone-acme", [{ id: "keep-me", expression: "(http.host eq \"other.acme.example.test\")", action: "rewrite" }]]]),
      tokens: [],
    },
    gh: {
      environments: new Set(),
      secrets: new Map(),
      variables: new Map([
        ["PIPELINE_ENVIRONMENTS", "fisqua-pipeline-existing"],
        ["PIPELINE_STORAGE_HOSTS", "s3.us-west-999.backblazeb2.com"],
      ]),
    },
    worker: new Map(),
    d1: {
      tenants: [{ id: options.tenantId ?? FAKE_TENANT_ID, slug: options.tenant ?? "sbmal", federation_id: FAKE_FEDERATION_ID }],
      federations: [emptyFederation(FAKE_FEDERATION_ID, federationSlug)],
      openRuns: 0,
      unpublishedVolumes: 0,
      writes: 0,
      pendingScopes: [],
      locks: new Map(),
      pendingPairs: new Map(),
    },
    calls: [],
    issued: [],
  };
  let n = 0;
  const fileIdOf = (f: FakeB2File) => f.fileId ?? `FAKEFILE-${f.fileName}`;
  /**
   * Each name's newest entry under a prefix, unless it is a hide marker;
   * an unfinished large file (`start`) is not listed by name, as in B2.
   */
  const visible = (bucketId: string, prefix: string) => {
    const newest = new Map<string, FakeB2File>();
    for (const f of world.b2.files.get(bucketId) ?? []) {
      if (f.fileName.startsWith(prefix) && f.action !== "start") newest.set(f.fileName, f);
    }
    return [...newest.values()].filter((f) => f.action !== "hide");
  };
  const call = (name: string) => {
    world.calls.push(name);
    if (options.failOn?.(name)) throw new Error(`fake failure at ${name}`);
  };

  const b2: B2Api = {
    async account() {
      call("b2.account");
      return { s3ApiUrl: FAKE_B2_S3, downloadUrl: FAKE_B2_DOWNLOAD };
    },
    async findBucket(name) {
      call("b2.findBucket");
      const bucket = world.b2.buckets.get(name);
      return bucket
        ? {
            ...bucket,
            revision: bucket.revision ?? 1,
            corsRules: bucket.corsRules.map(asB2Reports),
            ...(bucket.bucketInfo ? { bucketInfo: { ...bucket.bucketInfo } } : {}),
          }
        : null;
    },
    async createBucket(name, bucketType, corsRules, bucketInfo) {
      call(`b2.createBucket:${name}`);
      if (world.b2.taken.has(name)) throw new BucketNameTakenError(name);
      const bucket: B2Bucket = { bucketId: `bucket-${++n}`, bucketName: name, bucketType, corsRules, ...(bucketInfo ? { bucketInfo: { ...bucketInfo } } : {}) };
      world.b2.buckets.set(name, bucket);
      return bucket;
    },
    async updateBucket(bucketId, bucketType, corsRules, bucketInfo, ifRevisionIs) {
      call("b2.updateBucket");
      await options.beforeUpdateBucket?.(bucketId);
      // As B2 does: a field sent replaces the bucket's, one left out is
      // kept; with `ifRevisionIs`, a bucket at another revision is not
      // changed; every update raises the revision.
      for (const b of world.b2.buckets.values()) {
        if (b.bucketId !== bucketId) continue;
        if (ifRevisionIs !== undefined && (b.revision ?? 1) !== ifRevisionIs) {
          call("b2.updateBucket:conflict");
          throw new BucketRevisionConflictError(bucketId);
        }
        b.bucketType = bucketType;
        if (corsRules !== undefined) b.corsRules = corsRules;
        if (bucketInfo !== undefined) b.bucketInfo = { ...bucketInfo };
        b.revision = (b.revision ?? 1) + 1;
      }
    },
    async keyNames() {
      call("b2.keyNames");
      return world.b2.keys.map((k) => k.name);
    },
    async keys() {
      call("b2.keys");
      return world.b2.keys.map((k, i) => ({
        keyId: k.keyId ?? `FAKELISTEDKEY${i}`,
        keyName: k.name,
        bucketId: k.bucketId,
        namePrefix: k.namePrefix ?? null,
        capabilities: k.capabilities,
      }));
    },
    async createKey(name, capabilities, bucketId, namePrefix) {
      call(`b2.createKey:${name}`);
      const key = { keyId: `FAKEKEYID${++n}`, secret: `FAKESECRET${n}` };
      const entry = {
        name,
        bucketId,
        capabilities,
        ...(namePrefix ? { namePrefix } : {}),
        ...(options.listIssuedIds ? { keyId: key.keyId } : {}),
      };
      world.b2.keys.push(entry);
      world.b2.issuedKeys.set(key.keyId, entry);
      world.issued.push(key.keyId, key.secret);
      return key;
    },
    async deleteKey(keyId) {
      call(`b2.deleteKey:${keyId}`);
      const entry = world.b2.issuedKeys.get(keyId);
      world.b2.keys = world.b2.keys.filter((k) => k !== entry);
      world.b2.issuedKeys.delete(keyId);
    },
    async listFiles(bucketId, prefix) {
      call(`b2.listFiles:${prefix}`);
      return visible(bucketId, prefix).map((f) => ({ fileName: f.fileName, contentLength: f.contentLength }));
    },
    async listFolders(bucketId, prefix) {
      call(`b2.listFolders:${prefix}`);
      const folders = new Set<string>();
      for (const f of world.b2.files.get(bucketId) ?? []) {
        if (!f.fileName.startsWith(prefix)) continue;
        const rest = f.fileName.slice(prefix.length);
        const cut = rest.indexOf("/");
        if (cut >= 0) folders.add(prefix + rest.slice(0, cut + 1));
      }
      return [...folders].sort();
    },
    async listFileDetails(bucketId, prefix) {
      call(`b2.listFileDetails:${prefix}`);
      return visible(bucketId, prefix).map((f) => ({
        fileName: f.fileName,
        contentLength: f.contentLength,
        fileId: fileIdOf(f),
        sha1: sha1Of(f),
      }));
    },
    async listFileVersions(bucketId, prefix) {
      call(`b2.listFileVersions:${prefix}`);
      return (world.b2.files.get(bucketId) ?? [])
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => f.fileName.startsWith(prefix))
        .sort((a, b) => (a.f.fileName < b.f.fileName ? -1 : a.f.fileName > b.f.fileName ? 1 : b.i - a.i))
        .map(({ f }) =>
          f.action === "hide" || f.action === "start"
            ? { fileName: f.fileName, fileId: fileIdOf(f), action: f.action, contentLength: 0, sha1: null }
            : { fileName: f.fileName, fileId: fileIdOf(f), action: "upload" as const, contentLength: f.contentLength, sha1: sha1Of(f) },
        );
    },
    async hasFileVersions(bucketId) {
      call("b2.hasFileVersions");
      return (world.b2.files.get(bucketId) ?? []).length > 0;
    },
    async copyFile(sourceFileId, fileName, destinationBucketId) {
      call(`b2.copyFile:${fileName}`);
      let source: FakeB2File | undefined;
      for (const files of world.b2.files.values()) {
        source ??= files.find((f) => !f.action && fileIdOf(f) === sourceFileId);
      }
      if (!source) throw new Error(`fake copy: no file ${sourceFileId}`);
      const fileId = `FAKECOPY${++n}`;
      const made: FakeB2File = { ...source, fileName, fileId };
      const stored = options.onCopy ? options.onCopy(made) : made;
      const files = [...(world.b2.files.get(destinationBucketId) ?? []), stored];
      world.b2.files.set(destinationBucketId, files);
      options.afterCopy?.(stored, files);
      return { fileId };
    },
  };

  const cloudflare: CloudflareApi = {
    s3Endpoint: FAKE_R2_S3,
    async findZone(domain) {
      call("cf.findZone");
      return world.cf.zones.get(domain) ?? null;
    },
    async r2BucketExists(name) {
      call("cf.r2BucketExists");
      return world.cf.r2.has(name);
    },
    async createR2Bucket(name) {
      call("cf.createR2Bucket");
      world.cf.r2.add(name);
    },
    async r2Cors(name) {
      call("cf.r2Cors");
      return world.cf.cors.get(name) ?? null;
    },
    async putR2Cors(name, rules) {
      call("cf.putR2Cors");
      world.cf.cors.set(name, rules);
    },
    async r2CustomDomains(name) {
      call("cf.r2CustomDomains");
      return world.cf.domains.get(name) ?? [];
    },
    async addR2CustomDomain(name, domain) {
      call("cf.addR2CustomDomain");
      world.cf.domains.set(name, [...(world.cf.domains.get(name) ?? []), domain]);
    },
    async findCname(_zone, name) {
      call("cf.findCname");
      return world.cf.cnames.get(name) ?? null;
    },
    async createCname(_zone, name, content) {
      call("cf.createCname");
      world.cf.cnames.set(name, { content, proxied: true });
    },
    async transformRules(zone) {
      call("cf.transformRules");
      return [...(world.cf.rules.get(zone) ?? [])];
    },
    async putTransformRules(zone, rules) {
      call("cf.putTransformRules");
      world.cf.rules.set(zone, rules);
    },
    async tokenNames() {
      call("cf.tokenNames");
      return world.cf.tokens.map((t) => t.name);
    },
    async createR2WriteToken(name, bucket) {
      call(`cf.createR2WriteToken:${name}`);
      world.cf.tokens.push({ name, bucket });
      const key = { keyId: `FAKETOKENID${++n}`, secret: `FAKETOKENSECRET${n}` };
      world.issued.push(key.keyId, key.secret);
      return key;
    },
  };

  const github: GitHubApi = {
    async environmentExists(name) {
      call("gh.environmentExists");
      return world.gh.environments.has(name);
    },
    async createEnvironment(name) {
      call("gh.createEnvironment");
      world.gh.environments.add(name);
      world.gh.secrets.set(name, new Map());
    },
    async environmentSecretNames(name) {
      call("gh.environmentSecretNames");
      return [...(world.gh.secrets.get(name)?.keys() ?? [])];
    },
    async setEnvironmentSecret(environment, name, value) {
      call(`gh.setEnvironmentSecret:${name}`);
      world.gh.secrets.get(environment)!.set(name, value);
    },
    async variable(name) {
      call("gh.variable");
      return world.gh.variables.get(name) ?? null;
    },
    async setVariable(name, value) {
      call(`gh.setVariable:${name}`);
      world.gh.variables.set(name, value);
    },
  };

  const worker: WorkerSecretsApi = {
    async names() {
      call("worker.names");
      return [...world.worker.keys()];
    },
    async put(name, value) {
      call(`worker.put:${name}`);
      world.worker.set(name, value);
    },
  };

  const d1: D1Api = {
    async tenant(slug) {
      call("d1.tenant");
      return world.d1.tenants.find((t) => t.slug === slug) ?? null;
    },
    async federation(slug) {
      call("d1.federation");
      // A copy, as D1 returns: a run's snapshot does not follow later writes.
      const row = world.d1.federations.find((f) => f.slug === slug);
      return row ? { ...row } : null;
    },
    async federationById(id) {
      call("d1.federationById");
      const row = world.d1.federations.find((f) => f.id === id);
      return row ? { ...row } : null;
    },
    async tenantsOf(id) {
      call("d1.tenantsOf");
      return world.d1.tenants.filter((t) => t.federation_id === id).map((t) => t.slug);
    },
    async otherDestinations(id) {
      call("d1.otherDestinations");
      return world.d1.federations.filter((f) => f.id !== id);
    },
    async pendingWork(scope) {
      call("d1.pendingWork");
      world.d1.pendingScopes.push(scope);
      return { openRuns: world.d1.openRuns, unpublishedVolumes: world.d1.unpublishedVolumes };
    },
    async writeDestination(id, values, expected, fence) {
      call("d1.writeDestination");
      const row = world.d1.federations.find((f) => f.id === id)!;
      // As the statement does: only while the fence's lock holds, and only
      // when every record column still has the value the run read.
      const lock = world.d1.locks.get(fence.scope);
      if (!lock || lock.token !== fence.token || lock.expiresAt <= fence.now) return false;
      if (RECORD_COLUMNS.some((c) => (row[c] ?? null) !== (expected[c] ?? null))) return false;
      Object.assign(row, values);
      world.d1.writes++;
      return true;
    },
    async takeLock(scope, holder, token, now, expiresAt) {
      call(`d1.takeLock:${scope}`);
      const held = world.d1.locks.get(scope);
      if (held && held.expiresAt <= now) world.d1.locks.delete(scope);
      if (!world.d1.locks.has(scope)) world.d1.locks.set(scope, { holder, token, startedAt: now, expiresAt });
      const lock = world.d1.locks.get(scope)!;
      return { holder: lock.holder, token: lock.token, startedAt: lock.startedAt };
    },
    async renewLock(scope, token, now, expiresAt) {
      call(`d1.renewLock:${scope}`);
      const lock = world.d1.locks.get(scope);
      if (!lock || lock.token !== token || lock.expiresAt <= now) return false;
      lock.expiresAt = expiresAt;
      return true;
    },
    async releaseLock(scope, token) {
      call(`d1.releaseLock:${scope}`);
      if (world.d1.locks.get(scope)?.token === token) world.d1.locks.delete(scope);
    },
    async pendingPairs(scope) {
      call("d1.pendingPairs");
      return [...world.d1.pendingPairs.keys()].filter((k) => k.startsWith(`${scope} `)).map((k) => k.slice(scope.length + 1));
    },
    async markOf(scope, pair) {
      call(`d1.markOf:${pair}`);
      return world.d1.pendingPairs.get(`${scope} ${pair}`) ?? null;
    },
    async markPair(scope, pair, _holder, token, now, fenced) {
      call(`d1.markPair:${pair}`);
      if (fenced) {
        const lock = world.d1.locks.get(scope);
        if (!lock || lock.token !== token || lock.expiresAt <= now) return false;
      }
      world.d1.pendingPairs.set(`${scope} ${pair}`, token);
      return true;
    },
    async clearPair(scope, pair, token, now) {
      call(`d1.clearPair:${pair}`);
      // Only the mark's own run, while it holds the scope's unexpired lock, as the statement does.
      const key = `${scope} ${pair}`;
      const lock = world.d1.locks.get(scope);
      if (world.d1.pendingPairs.get(key) !== token || !lock || lock.token !== token || lock.expiresAt <= now) return false;
      world.d1.pendingPairs.delete(key);
      return true;
    },
  };

  return { world, providers: { b2, cloudflare, github, worker, d1, now: () => 1_800_000_000_000, holder: "fake-run" } };
}

// @version v0.8.0
