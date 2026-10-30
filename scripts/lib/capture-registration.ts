/**
 * Scripts — registering capture volumes from a Captua capture manifest
 *
 * This module deals with turning a capture manifest, the file a Captua
 * appliance writes when it hands a batch of captured volumes over, into
 * the media pipeline's volume and page rows, so the volumes can be
 * dispatched. The command in `scripts/commands/register-capture-volumes.ts`
 * is a thin shell around `registerCaptureVolumes` here.
 *
 * The checks a manifest goes through are not here: they are pure
 * functions in `app/lib/capture/manifest.ts`, which the Worker's
 * delivery endpoint (`POST /api/capture/v1/manifests`) runs as well, so
 * a manifest a unit delivers and one an operator registers from a file
 * meet the same checks. This module re-exports
 * them (`planVolumes`, `planPages`, `applyInventory`, `unlistedVolumes`,
 * `folderOf` and their types) for the command and its tests. That
 * module's header describes each check. `parseCaptureManifest` and
 * `checkTransferRoot` here turn its answers into a `RegistrationStop`
 * listing every problem, which is how the command refuses a file.
 *
 * `unlistedVolumes` reports the volume folders under the tenant's prefix
 * `{slug}/` in the masters bucket that this manifest does not name and
 * that no pipeline volume of the tenant is registered under, so a volume
 * present in the transfer but missing from the manifest is reported
 * rather than dropped without a word. The masters bucket holds every
 * volume the tenant has shipped, and Captua sends one manifest per
 * volume or batch, so folders already registered are not reported. The
 * report is information only: it rejects nothing and writes nothing.
 *
 * `registrationSql` writes the statements for every volume that passed,
 * for one file applied with `wrangler d1 execute --file`. They are the
 * statements the delivery endpoint writes (`fileRegistrationSql` in
 * `app/lib/capture/file-route.server.ts`, over the link's own builder),
 * rendered as SQL text: a new volume is inserted in state `received`
 * with its pages; a re-registered one has its masters columns, expected
 * count and page revision updated, its pages deleted and the new ones
 * inserted; and each volume's manifest is recorded as a capture delivery
 * with route `file`, which supersedes the volume's older delivery and
 * holds the volume for capture QC, with its records and images. Every
 * statement names the tenant in each table it reads or writes, and every
 * one is guarded by the state it was planned against (the description
 * exists, no volume holds it yet, or the volume is still `received`, no
 * open run holds it and no run has named it), so a volume that changed
 * between the read and the write is left untouched rather than
 * half-written; the re-read after applying shows it, with the delivery
 * that holds each volume. A volume a run has ever named is left alone at
 * planning, as the link refuses it.
 *
 * Right after planning, before the state of a volume or its objects
 * count, each volume's delivery id is looked up among the tenant's
 * deliveries (`setAsideRecorded`), as the delivery endpoint looks up a
 * repeated manifest id before any other check. Recorded with the same body digest,
 * it is a replay: the volume is set aside as `already_registered` and
 * nothing is written for it again, so a file can be applied again, or a
 * multi-volume file retried once a skipped volume is put right.
 * Recorded with another digest, the volume is set aside as `id_reused`.
 * Either way the file's other volumes go on.
 *
 * The statements are built for every volume that passed, in a dry run
 * too. A volume with a statement larger than D1 takes is set aside as
 * `too_large`, and the file's other volumes are written.
 *
 * The read statements (`descriptionsQuery`, `existingVolumesQuery`,
 * `registeredFoldersQuery`, `verifyQuery`) go through `wrangler d1 execute --command`, never
 * `--file`: against a remote database `--file` is an import and returns
 * no rows. `wranglerRows` runs them through an injected command runner.
 *
 * @version v0.8.0
 */

import { escapeSql } from "./sql";
import { fileDeliveryId, fileRegistrationSql } from "../../app/lib/capture/file-route.server";
import { CaptureBudgetError, repeatedDelivery } from "../../app/lib/capture/link.server";
import { bodyDigest } from "../../app/lib/capture/token";
import {
  d1Args,
  findRecordBucket,
  ProvisionStop,
  resolveTenantStorage,
  type B2Api,
  type CommandRunner,
  type D1Api,
  type DestinationValues,
  type Log,
  type Target,
} from "./tenant-storage";
import {
  applyInventory,
  checkCaptureManifest,
  folderOf,
  planVolumes,
  setAside,
  transferRootProblem,
  unlistedVolumes,
  type CaptureManifest,
  type DescriptionMatch,
  type ExistingVolume,
  type PlannedVolume,
} from "../../app/lib/capture/manifest";

// The checks live in the app, where the delivery endpoint runs them
// too; re-exported here for the command and its tests.
export {
  applyInventory,
  CAPTURE_CONTRACT,
  CAPTURE_KIND,
  CAPTURE_VERSION,
  folderOf,
  mastersPrefixFor,
  NON_VOLUME_FOLDERS,
  planPages,
  planVolumes,
  unlistedVolumes,
  type CaptureImage,
  type CaptureManifest,
  type CaptureRecord,
  type CaptureVolume,
  type DescriptionMatch,
  type ExistingVolume,
  type ManifestObject,
  type PagePlan,
  type PlanInput,
  type PlannedPage,
  type PlannedVolume,
  type SkipReason,
  type VolumeInventory,
} from "../../app/lib/capture/manifest";

/** A stop that names every problem it found. */
export class RegistrationStop extends ProvisionStop {
  readonly problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(problems.length > 0 ? `${message}:\n  ${problems.join("\n  ")}` : message);
    this.name = "RegistrationStop";
    this.problems = problems;
  }
}

/** The manifest, or a stop listing why the whole file is refused. */
export function parseCaptureManifest(raw: unknown): CaptureManifest {
  const checked = checkCaptureManifest(raw);
  if (!checked.ok) {
    throw new RegistrationStop(
      "The capture manifest is refused whole",
      checked.problems.map((p) => p.message),
    );
  }
  return checked.manifest;
}

/** Stops unless the manifest's transfer root is the tenant's slug prefix. */
export function checkTransferRoot(manifest: CaptureManifest, slug: string): void {
  const problem = transferRootProblem(manifest, slug);
  if (problem) throw new RegistrationStop(problem.message);
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** The masters columns a registered volume takes from the federation's record. */
export interface MastersStore {
  backend: "b2";
  endpoint: string;
  bucket: string;
}

export function mastersStoreFor(record: DestinationValues): MastersStore {
  return { backend: "b2", endpoint: record.pipeline_delivery_endpoint, bucket: record.pipeline_masters_bucket };
}

/** A volume no open run holds: the hold predicate of dispatch, over `pipeline_volumes`. */
export function notHeldSql(tenantId: string, now: number): string {
  const t = escapeSql(tenantId);
  return (
    `(pipeline_volumes.held_by_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM pipeline_runs r ` +
    `WHERE r.tenant_id = ${t} AND r.id = pipeline_volumes.held_by_run_id ` +
    `AND r.token_revoked_at IS NULL AND r.token_expires_at > ${now}))`
  );
}

export interface RegistrationSqlInput {
  tenantId: string;
  manifest: CaptureManifest;
  volumes: PlannedVolume[];
  store: MastersStore;
  /** The SHA-256 of the manifest file's body in canonical form. */
  digest: string;
  /** The masters listing of each volume's prefix: full key to size. */
  listings: Map<string, Map<string, number>>;
  now: number;
  newId: () => string;
}

export interface RegistrationSql {
  statements: string[];
  /** Each written volume's delivery id, by volume id. */
  deliveries: Map<string, string>;
  /** Why a volume's statements were left out, by stem: one would pass what D1 takes. */
  tooLarge: Map<string, string>;
}

/**
 * The statements that write every registered and re-registered volume
 * with its delivery, in order, for one file (module header). A volume
 * with a statement past what D1 takes is left out and named in
 * `tooLarge`; the others are written.
 */
export async function registrationSql(input: RegistrationSqlInput): Promise<RegistrationSql> {
  const statements: string[] = [];
  const deliveries = new Map<string, string>();
  const tooLarge = new Map<string, string>();
  for (const v of input.volumes) {
    if (v.action === "skip") continue;
    try {
      const written = await fileRegistrationSql({
        tenantId: input.tenantId,
        manifest: input.manifest,
        volume: v,
        digest: input.digest,
        masters: { endpoint: input.store.endpoint, bucket: input.store.bucket },
        listing: input.listings.get(v.mastersPrefix as string) ?? new Map(),
        now: input.now,
        newId: input.newId,
      });
      statements.push(...written.statements);
      deliveries.set(v.volumeId as string, written.deliveryId);
    } catch (err) {
      if (err instanceof CaptureBudgetError) {
        tooLarge.set(v.stem, err.message);
        continue;
      }
      throw err;
    }
  }
  return { statements, deliveries, tooLarge };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** IN-list chunk for the read statements, to keep each `--command` short. */
export const READ_CHUNK = 100;

function inList(values: string[]): string {
  return values.map(escapeSql).join(", ");
}

export function descriptionsQuery(tenantId: string, codes: string[]): string {
  return (
    `SELECT id, reference_code FROM descriptions WHERE tenant_id = ${escapeSql(tenantId)} ` +
    `AND reference_code IN (${inList(codes)});`
  );
}

export function existingVolumesQuery(tenantId: string, descriptionIds: string[], codes: string[], now: number): string {
  return (
    `SELECT id, description_id, reference_code, kind, state, ` +
    `CASE WHEN ${notHeldSql(tenantId, now)} THEN 0 ELSE 1 END AS held, ` +
    `EXISTS (SELECT 1 FROM pipeline_run_volumes rv WHERE rv.tenant_id = ${escapeSql(tenantId)} ` +
    `AND rv.pipeline_volume_id = pipeline_volumes.id) AS ran ` +
    `FROM pipeline_volumes WHERE pipeline_volumes.tenant_id = ${escapeSql(tenantId)} ` +
    `AND (description_id IN (${inList(descriptionIds)}) OR reference_code IN (${inList(codes)}));`
  );
}

/** Where each of the tenant's pipeline volumes keeps its masters. */
export function registeredFoldersQuery(tenantId: string): string {
  return `SELECT masters_prefix, masters_key FROM pipeline_volumes WHERE tenant_id = ${escapeSql(tenantId)};`;
}

/** The tenant's deliveries recorded under any of `ids`, with their body digests. */
export function recordedDeliveriesQuery(tenantId: string, ids: string[]): string {
  return (
    `SELECT id, body_sha256 FROM capture_deliveries WHERE tenant_id = ${escapeSql(tenantId)} ` +
    `AND id IN (${inList(ids)});`
  );
}

/**
 * Sets aside each planned volume whose delivery id is already recorded,
 * as the delivery endpoint answers a repeated id (`repeatedDelivery`):
 * the same body is a replay and writes nothing again; another body is
 * refused as `id_reused`. The other volumes go on.
 */
async function setAsideRecorded(
  manifest: CaptureManifest,
  volumes: PlannedVolume[],
  tenantId: string,
  digest: string,
  rows: RowReader,
): Promise<PlannedVolume[]> {
  const ids = new Map<string, string>();
  for (const v of volumes) ids.set(v.stem, await fileDeliveryId(manifest, v.stem));
  const recorded = new Map<string, string>();
  for (const part of chunks([...ids.values()], READ_CHUNK)) {
    for (const r of await rows(recordedDeliveriesQuery(tenantId, part))) recorded.set(String(r.id), String(r.body_sha256));
  }
  return volumes.map((v) => {
    const id = ids.get(v.stem);
    const sha = id === undefined ? undefined : recorded.get(id);
    if (id === undefined || sha === undefined) return v;
    return repeatedDelivery(sha, digest) === "replay"
      ? setAside(v, "already_registered", [`delivery ${id} already holds this manifest`])
      : setAside(v, "id_reused", [
          `delivery ${id} was recorded from a different body; a changed manifest needs a new id`,
        ]);
  });
}

export function verifyQuery(tenantId: string, volumeIds: string[]): string {
  const t = escapeSql(tenantId);
  return (
    `SELECT v.id AS id, v.state AS state, v.expected_count AS expected_count, ` +
    `(SELECT COUNT(*) FROM pipeline_volume_pages p WHERE p.tenant_id = ${t} AND p.pipeline_volume_id = v.id) AS pages, ` +
    `(SELECT COUNT(*) FROM pipeline_volume_pages p WHERE p.tenant_id = ${t} AND p.pipeline_volume_id = v.id ` +
    `AND p.sha256 IS NOT NULL) AS digests, ` +
    `(SELECT d.id FROM capture_deliveries d WHERE d.tenant_id = ${t} AND d.pipeline_volume_id = v.id ` +
    `AND d.state = 'registered') AS delivery_id ` +
    `FROM pipeline_volumes v WHERE v.tenant_id = ${t} AND v.id IN (${inList(volumeIds)});`
  );
}

export type RowReader = (sql: string) => Promise<Record<string, unknown>[]>;

/**
 * Read rows through `wrangler d1 execute --command --json`. Remote output
 * can carry status lines before the JSON, so everything before the first
 * JSON token is dropped.
 */
export function wranglerRows(target: Target, run: CommandRunner): RowReader {
  return async (sql) => {
    const out = run("npx", [...d1Args(target), "--json", "--command", sql], {});
    const start = out.search(/[[{]/);
    if (start < 0) throw new ProvisionStop(`wrangler produced no JSON output: ${out.slice(0, 200)}`);
    const parsed = JSON.parse(out.slice(start)) as Array<{ results?: Record<string, unknown>[] }>;
    return parsed[0]?.results ?? [];
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface RegistrationOptions {
  /** The tenant's slug. */
  slug: string;
  target: Target;
  apply: boolean;
  /** Staging tests only; refused with `target` production. */
  allowCaptured?: boolean;
  /**
   * The SHA-256 of the manifest file's body in canonical form, as the
   * link digests a body. Without it, the parsed manifest's.
   */
  bodySha256?: string;
}

export interface RegistrationProviders {
  d1: D1Api;
  rows: RowReader;
  /** Null without the operator's B2 credentials; `--apply` needs them. */
  b2: B2Api | null;
  /** Writes a local file (the report, the SQL file). */
  writeFile: (path: string, text: string) => void;
  /** Applies a SQL file to the target with `wrangler d1 execute --file`. */
  applyFile: (path: string) => void;
  now: () => number;
  newId: () => string;
}

export interface VerifiedVolume {
  volumeId: string;
  state: string | null;
  expectedCount: number | null;
  pages: number;
  digests: number;
  /** The delivery that holds the volume, read back; null when there is none. */
  deliveryId: string | null;
  ok: boolean;
}

export interface RegistrationReport {
  manifestId: string;
  tenant: string;
  target: Target;
  applied: boolean;
  inventory: "checked" | "unchecked";
  /**
   * Volume folders under `{slug}/` in the masters bucket that are not in
   * the manifest or registered; absent when the inventory is unchecked.
   */
  unlistedVolumes?: string[];
  volumes: Array<Omit<PlannedVolume, "objects" | "pages" | "issues"> & { pageCount?: number }>;
  verification?: VerifiedVolume[];
}

export const OUTPUT_DIR = ".import";

export function reportPath(manifestId: string): string {
  return `${OUTPUT_DIR}/capture-registration_${manifestId}.json`;
}

export function sqlPath(manifestId: string): string {
  return `${OUTPUT_DIR}/capture-registration_${manifestId}.sql`;
}

function volumeLine(v: PlannedVolume): string {
  const name = `${v.stem} (${v.externalId ?? "no externalId"})`;
  if (v.action === "skip") return `  [skip] ${name}: ${v.reason}${v.detail?.length ? `\n      ${v.detail.join("\n      ")}` : ""}`;
  const inv = v.inventory;
  const size = inv ? `, ${inv.masterBytes} bytes of masters` : ", masters unchecked";
  const extra = inv
    ? [
        ...inv.unlisted.map((o) => `not in the manifest: ${o.key} (${o.size} bytes)`),
        ...inv.missingOthers.map((k) => `in the manifest, not in the bucket: ${k}`),
      ]
    : [];
  return (
    `  [${v.action}] ${name}: ${v.pages?.length} pages under ${v.mastersPrefix}${size}` +
    (extra.length ? `\n      ${extra.join("\n      ")}` : "")
  );
}

/**
 * Registers the volumes of one parsed manifest for one tenant: reads,
 * plans, takes the inventory, writes the report, and with `apply` writes
 * the rows in one file and re-reads them. Returns the report.
 */
export async function registerCaptureVolumes(
  manifest: CaptureManifest,
  options: RegistrationOptions,
  providers: RegistrationProviders,
  log: Log,
): Promise<RegistrationReport> {
  if (options.allowCaptured && options.target === "production") {
    throw new RegistrationStop("--allow-captured is for staging tests and is refused against production");
  }
  const { tenant, federation } = await resolveTenantStorage(options.slug, providers.d1);
  checkTransferRoot(manifest, tenant.slug);
  if (options.apply && !providers.b2) {
    throw new RegistrationStop("--apply needs the operator's B2 credentials, to check the masters are in the bucket");
  }
  const now = providers.now();
  log(`Tenant ${tenant.slug} (${tenant.id}), federation ${federation.slug}, target ${options.target}`);
  log(`Manifest ${manifest.id}: ${manifest.volumes.length} volumes, masters in ${federation.pipeline_masters_bucket}`);

  const codes = manifest.volumes.map((v) => v.externalId).filter((c): c is string => c !== null);
  const descriptions = new Map<string, DescriptionMatch>();
  for (const part of chunks(codes, READ_CHUNK)) {
    for (const r of await providers.rows(descriptionsQuery(tenant.id, part))) {
      descriptions.set(String(r.reference_code), { id: String(r.id), referenceCode: String(r.reference_code) });
    }
  }
  const existing: ExistingVolume[] = [];
  const matched = [...descriptions.values()];
  for (const part of chunks(matched, READ_CHUNK)) {
    const rows = await providers.rows(
      existingVolumesQuery(tenant.id, part.map((d) => d.id), part.map((d) => d.referenceCode), now),
    );
    for (const r of rows) {
      if (existing.some((e) => e.id === String(r.id))) continue;
      existing.push({
        id: String(r.id),
        descriptionId: String(r.description_id),
        referenceCode: String(r.reference_code),
        kind: String(r.kind),
        state: String(r.state),
        held: Number(r.held) === 1,
        ran: Number(r.ran) === 1,
      });
    }
  }

  let volumes = planVolumes({
    manifest, slug: tenant.slug, descriptions, existing, newId: providers.newId, allowCaptured: options.allowCaptured,
  });
  // A delivery already recorded answers first, whatever the volume's
  // state or objects are now, as the delivery endpoint answers a
  // repeated id before any other check.
  const digest = options.bodySha256 ?? (await bodyDigest(manifest));
  volumes = await setAsideRecorded(manifest, volumes, tenant.id, digest, providers.rows);

  log("");
  log("Inventory");
  let inventory: RegistrationReport["inventory"] = "unchecked";
  const listings = new Map<string, Map<string, number>>();
  let unlisted: string[] | undefined;
  if (providers.b2) {
    const bucketId = await findRecordBucket(providers.b2, federation.pipeline_masters_bucket, "masters bucket", log);
    for (const v of volumes) {
      if (v.action === "skip") continue;
      const prefix = v.mastersPrefix as string;
      const files = await providers.b2.listFiles(bucketId, prefix);
      listings.set(prefix, new Map(files.map((f) => [f.fileName, f.contentLength])));
    }
    volumes = applyInventory(volumes, listings);
    inventory = "checked";
    log(`  [listed] ${listings.size} volume prefixes`);

    const registered: string[] = [];
    for (const r of await providers.rows(registeredFoldersQuery(tenant.id))) {
      if (r.masters_prefix != null) registered.push(String(r.masters_prefix));
      const folder = r.masters_key != null ? folderOf(String(r.masters_key), tenant.slug) : null;
      if (folder) registered.push(folder);
    }
    const folders = await providers.b2.listFolders(bucketId, `${tenant.slug}/`);
    unlisted = unlistedVolumes(folders, tenant.slug, manifest.volumes.map((v) => v.stem), registered);
    for (const f of unlisted) log(`  [unlisted] ${f} is in the masters bucket and not in this manifest or registered`);
  } else {
    log("  [unchecked] masters bucket (no B2 credentials)");
  }

  // The statements are built for every volume that passed, so a volume
  // whose statement D1 would refuse is set aside here and the others go on.
  const built = await registrationSql({
    tenantId: tenant.id,
    manifest,
    volumes,
    store: mastersStoreFor(federation),
    digest,
    listings,
    now,
    newId: providers.newId,
  });
  volumes = volumes.map((v) => {
    const reason = built.tooLarge.get(v.stem);
    return reason === undefined ? v : setAside(v, "too_large", [reason]);
  });

  log("");
  log("Volumes");
  for (const v of volumes) log(volumeLine(v));

  const writes = volumes.filter((v) => v.action !== "skip");
  const report: RegistrationReport = {
    manifestId: manifest.id,
    tenant: tenant.slug,
    target: options.target,
    applied: false,
    inventory,
    ...(unlisted ? { unlistedVolumes: unlisted } : {}),
    volumes: volumes.map(({ objects: _o, issues: _i, pages, ...rest }) => ({
      ...rest,
      ...(pages ? { pageCount: pages.length } : {}),
    })),
  };

  if (options.apply && writes.length > 0) {
    const { statements, deliveries } = built;
    const file = sqlPath(manifest.id);
    providers.writeFile(file, statements.join("\n") + "\n");
    log("");
    log(`Wrote ${statements.length} statements to ${file}`);
    providers.applyFile(file);
    report.applied = true;

    const verified: VerifiedVolume[] = [];
    for (const part of chunks(writes, READ_CHUNK)) {
      const rows = await providers.rows(verifyQuery(tenant.id, part.map((v) => v.volumeId as string)));
      for (const v of part) {
        const r = rows.find((row) => String(row.id) === v.volumeId);
        const pages = Number(r?.pages ?? 0);
        const digests = Number(r?.digests ?? 0);
        const expected = r ? Number(r.expected_count) : null;
        const count = (v.pages ?? []).length;
        const deliveryId = r?.delivery_id != null ? String(r.delivery_id) : null;
        verified.push({
          volumeId: v.volumeId as string,
          state: r ? String(r.state) : null,
          expectedCount: expected,
          pages,
          digests,
          deliveryId,
          ok:
            !!r &&
            String(r.state) === "received" &&
            expected === count &&
            pages === count &&
            digests === count &&
            deliveryId === deliveries.get(v.volumeId as string),
        });
      }
    }
    report.verification = verified;
    log("");
    log("Re-read");
    for (const [i, x] of verified.entries()) {
      log(
        `  [${x.ok ? "ok" : "mismatch"}] ${writes[i].stem}: ${x.pages} pages, ${x.digests} digests, ` +
          `expected ${x.expectedCount ?? "-"}, state ${x.state ?? "absent"}, delivery ${x.deliveryId ?? "none"}`,
      );
    }
  } else if (options.apply) {
    log("");
    log("Nothing to write.");
  }

  providers.writeFile(reportPath(manifest.id), JSON.stringify(report, null, 2) + "\n");
  log("");
  log(`Report: ${reportPath(manifest.id)}`);
  if (report.verification?.some((x) => !x.ok)) {
    throw new RegistrationStop("The re-read does not match what was written; see the report");
  }
  return report;
}

// @version v0.8.0
