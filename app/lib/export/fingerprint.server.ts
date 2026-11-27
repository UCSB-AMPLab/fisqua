/**
 * Per-Fonds Export Fingerprints
 *
 * This module deals with deciding whether a per-fonds publish step
 * (the descriptions file, the children files, the EAD3 file, the Dublin
 * Core file) can leave its files as they are. Each step's files are a
 * function of a fixed set of inputs; `fondsFingerprint` hashes those
 * inputs, and `runUnlessUnchanged` compares the hash with the one the
 * step recorded the last time it succeeded for the fonds. When the two
 * are equal and the step's main object is still in the bucket, the step
 * writes nothing and returns the result it recorded, marked
 * `skipped: true`.
 *
 * The hash is SHA-256 (Web Crypto) over, in order:
 *
 *   - `EXPORT_FORMAT_VERSION`, raised whenever the code that writes a
 *     per-fonds file changes its bytes, so every file is written again;
 *   - the step's kind;
 *   - the fonds' tenant: id, federation and descriptive standard (the
 *     standard picks the EAD3 profile);
 *   - the fonds' root description, found as the steps find it (reference
 *     code and tenant), or its absence;
 *   - every description of the fonds, published or not, as id,
 *     `updated_at` and `is_published`, in id order, read a chunk at a
 *     time by keyset on `descriptions_tenant_root_id_idx`. Every write
 *     path that changes a field a per-fonds file carries moves the row's
 *     `updated_at` (record-version.server.ts), including a new OCR text
 *     and a change of child count; a move into or out of the fonds adds
 *     or removes an id;
 *   - `updated_at` of every repository the fonds' descriptions name
 *     (the chunk read takes each row's `repository_id` for this only);
 *   - the tenant's `mets_base_url`, which every `mets_url` is built from;
 *   - the federation's hosting statement, as `readFederationHosting`
 *     gives it, which the EAD3 and Dublin Core attribution line carries;
 *     `federations` has no `updated_at`, so the values are hashed;
 *   - for the descriptions kind, and only when a published description
 *     of the fonds records a code under `former-reference-code`: those
 *     former codes that a description of a member tenant holds now,
 *     sorted, as `liveFormerCodes` (pipeline.server.ts) gives them, the
 *     function the descriptions step reads them with. The file leaves a
 *     live former code out, and an import that makes a code live does not
 *     touch the row holding it as a former code; a code going live that
 *     is not one of the fonds' former codes changes nothing. The other
 *     kinds do not read live codes.
 *
 * The fingerprint is computed at the start of the step, before the
 * step's first read, and recorded only after the step's writes have
 * succeeded. An edit made while the step runs therefore leaves a
 * recorded fingerprint that differs from the next run's, and that run writes
 * the files again.
 *
 * The record (the marker) is one JSON object per fonds at
 * `{slug}/fingerprints/{fonds}.json`, beside the per-fonds files:
 * `{ "<kind>": { fingerprint, exportId, at, result } }`. `result` is the
 * count the step returned, which a skipped step returns again, since the
 * descriptions index is built from the per-fonds record counts. Writing
 * a kind's entry reads the marker again and replaces that entry alone,
 * so the other kinds' entries are kept. A step that throws writes no
 * entry. A forced run computes and records the fingerprint but never
 * skips.
 *
 * @version v0.9.0
 */

import { and, asc, eq, gt, inArray, like } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { descriptions, repositories, tenants } from "../../db/schema";
import { readFederationHosting } from "../pipeline/dispatch.server";
import { FORMER_REFERENCE_PROVIDER, legacyIdsOf } from "./former-codes.server";
import { liveFormerCodes } from "./pipeline.server";
import type { ExportTenant } from "./types";

/** Raised whenever the bytes a per-fonds file is written with change. */
export const EXPORT_FORMAT_VERSION = 2;

/** The per-fonds step kinds that keep a fingerprint. */
export type FingerprintKind = "descriptions" | "children" | "ead" | "dc";

/** Rows per read of the fonds' descriptions. */
export const FINGERPRINT_CHUNK = 5000;

/** Repository ids per read: D1 binds at most 100 parameters. */
const REPOSITORY_ID_CHUNK = 90;

/** The storage calls the marker and the main-object check need. */
export interface FingerprintStorage {
  getObjectHead(key: string): Promise<{ size: number } | null>;
  getObjectBytes(key: string): Promise<Uint8Array | null>;
  putObject(key: string, body: string): Promise<void>;
}

export interface FingerprintOptions {
  /** The format version hashed; a test seam, `EXPORT_FORMAT_VERSION` otherwise. */
  formatVersion?: number;
  /**
   * The tenants whose live reference codes the descriptions file leaves
   * out of its former codes; the fonds' own tenant when not given.
   */
  memberTenantIds?: readonly string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The fingerprint of one per-fonds step's inputs (module header), as a
 * hex SHA-256.
 */
export async function fondsFingerprint(
  db: DrizzleD1Database<any>,
  tenant: ExportTenant,
  fondsCode: string,
  kind: FingerprintKind,
  options: FingerprintOptions = {},
  chunk = FINGERPRINT_CHUNK
): Promise<string> {
  const parts: string[] = [
    `format:${options.formatVersion ?? EXPORT_FORMAT_VERSION}`,
    `kind:${kind}`,
    `tenant:${tenant.id}|${tenant.federationId}|${tenant.descriptiveStandard}`,
    `fonds:${fondsCode}`,
  ];

  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(and(eq(descriptions.referenceCode, fondsCode), eq(descriptions.tenantId, tenant.id)))
    .get();
  parts.push(`root:${root?.id ?? ""}`);

  const repositoryIds = new Set<string>();
  if (root) {
    let after: string | null = null;
    for (;;) {
      const rows: { id: string; updatedAt: number; isPublished: boolean | null; repositoryId: string }[] = await db
        .select({
          id: descriptions.id,
          updatedAt: descriptions.updatedAt,
          isPublished: descriptions.isPublished,
          repositoryId: descriptions.repositoryId,
        })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.rootDescriptionId, root.id),
            after === null ? undefined : gt(descriptions.id, after)
          )
        )
        .orderBy(asc(descriptions.id))
        .limit(chunk)
        .all();
      if (rows.length === 0) break;
      parts.push(
        await sha256Hex(rows.map((r) => `${r.id}|${r.updatedAt}|${r.isPublished ? 1 : 0}`).join("\n"))
      );
      for (const r of rows) repositoryIds.add(r.repositoryId);
      after = rows[rows.length - 1].id;
      if (rows.length < chunk) break;
    }
  }

  const repoIds = [...repositoryIds].sort();
  for (let i = 0; i < repoIds.length; i += REPOSITORY_ID_CHUNK) {
    const rows = await db
      .select({ id: repositories.id, updatedAt: repositories.updatedAt })
      .from(repositories)
      .where(
        and(
          eq(repositories.tenantId, tenant.id),
          inArray(repositories.id, repoIds.slice(i, i + REPOSITORY_ID_CHUNK))
        )
      )
      .orderBy(asc(repositories.id))
      .all();
    for (const r of rows) parts.push(`repository:${r.id}|${r.updatedAt}`);
  }

  const metsBaseUrl = (
    await db.select({ metsBaseUrl: tenants.metsBaseUrl }).from(tenants).where(eq(tenants.id, tenant.id)).get()
  )?.metsBaseUrl;
  parts.push(`mets:${JSON.stringify(metsBaseUrl ?? null)}`);

  const hosting = await readFederationHosting(db, tenant.federationId);
  parts.push(`hosting:${JSON.stringify(hosting ? [hosting.hostingStatementEs, hosting.hostingStatementEn] : null)}`);

  if (kind === "descriptions" && root) {
    // The published rows that may hold a former code, as the step's
    // outline reads them; the LIKE narrows the read to the holders.
    const holders = await db
      .select({ legacyIds: descriptions.legacyIds })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, tenant.id),
          eq(descriptions.rootDescriptionId, root.id),
          eq(descriptions.isPublished, true),
          like(descriptions.legacyIds, `%${FORMER_REFERENCE_PROVIDER}%`)
        )
      )
      .all();
    const former = holders.flatMap((r) => legacyIdsOf(r.legacyIds, FORMER_REFERENCE_PROVIDER));
    if (former.length > 0) {
      const live = await liveFormerCodes(db, former, options.memberTenantIds ?? [tenant.id]);
      parts.push(`live:${JSON.stringify([...live].sort())}`);
    }
  }

  return sha256Hex(parts.join("\n"));
}

/** One kind's entry in a fonds' marker. */
export interface FingerprintEntry<R = unknown> {
  fingerprint: string;
  exportId: string;
  at: number;
  result: R;
}

/** The key of a fonds' marker. */
export function fingerprintKey(slug: string, fondsCode: string): string {
  return `${slug}/fingerprints/${fondsCode}.json`;
}

/** The fonds' marker, or an empty one when there is none or it does not parse. */
export async function readFingerprints(
  storage: FingerprintStorage,
  slug: string,
  fondsCode: string
): Promise<Record<string, FingerprintEntry>> {
  const bytes = await storage.getObjectBytes(fingerprintKey(slug, fondsCode));
  if (!bytes) return {};
  try {
    const parsed = JSON.parse(dec.decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Write one kind's entry, keeping every other kind's. */
export async function writeFingerprint(
  storage: FingerprintStorage,
  slug: string,
  fondsCode: string,
  kind: FingerprintKind,
  entry: FingerprintEntry
): Promise<void> {
  const marker = await readFingerprints(storage, slug, fondsCode);
  marker[kind] = entry;
  await storage.putObject(fingerprintKey(slug, fondsCode), JSON.stringify(marker));
}

export interface UnchangedRunOptions extends FingerprintOptions {
  db: DrizzleD1Database<any>;
  storage: FingerprintStorage;
  tenant: ExportTenant;
  fondsCode: string;
  kind: FingerprintKind;
  exportId: string;
  /** The object the step writes whose absence means its files are not in place. */
  mainKey: string;
  /** Ignore the marker; the step runs and records its fingerprint. */
  force?: boolean;
  /** Test seam: the time recorded in the entry. */
  now?: () => number;
}

/**
 * Run a per-fonds step unless its fingerprint matches the one recorded
 * and its main object exists (module header). The result is the step's
 * own, or the recorded one, with `skipped` saying which.
 */
export async function runUnlessUnchanged<R extends object>(
  options: UnchangedRunOptions,
  run: () => Promise<R>
): Promise<R & { skipped: boolean }> {
  const { db, storage, tenant, fondsCode, kind } = options;
  const fingerprint = await fondsFingerprint(db, tenant, fondsCode, kind, options);

  if (!options.force) {
    const recorded = (await readFingerprints(storage, tenant.slug, fondsCode))[kind];
    if (
      recorded &&
      recorded.fingerprint === fingerprint &&
      recorded.result &&
      typeof recorded.result === "object" &&
      (await storage.getObjectHead(options.mainKey))
    ) {
      return { ...(recorded.result as R), skipped: true };
    }
  }

  const result = await run();
  const { skipped: _skipped, ...plain } = result as R & { skipped?: boolean };
  await writeFingerprint(storage, tenant.slug, fondsCode, kind, {
    fingerprint,
    exportId: options.exportId,
    at: (options.now ?? Date.now)(),
    result: plain,
  });
  return { ...result, skipped: false };
}

// @version v0.9.0
