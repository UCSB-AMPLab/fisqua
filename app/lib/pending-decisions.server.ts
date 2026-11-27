/**
 * Pending decisions — server core.
 *
 * The queue where a workspace's open questions wait for a ruling.
 * This module owns the two kinds backed by the pending_decisions table:
 *
 *   authority-proposal   filed by imports and bulk loads; ruled
 *                        accept / amend / reject. Accepting a mint
 *                        proposal creates the entity or place under the
 *                        maintaining agency's code prefix; accepting a
 *                        link proposal records the existing record it
 *                        resolves to. Topic proposals create nothing on
 *                        acceptance — the ruling itself is the product,
 *                        consumed by whatever filed the question.
 *                        Two things may ride along with an acceptance:
 *                        the evidence link (a junction row joining the
 *                        ruled record to the description its quote
 *                        cites) and a confirmed external match (a row
 *                        in external_authority_links, 0076). Both are
 *                        subordinate to the ruling and neither can be
 *                        conjured by the caller — the link resolves a
 *                        reference code inside the tenant's own scope,
 *                        and the match must be one the payload already
 *                        proposed.
 *
 *   duplicate-pair       a scan-flagged pair made durable (0072). The
 *                        scan stays live and unpersisted; a row exists
 *                        only once something durable happens — a
 *                        comment lands on the pair, or it is ruled
 *                        'merged' (survivor in result_id) or
 *                        'kept_both' (the persisted "not a duplicate"
 *                        the scan subtracts). source_ref carries the
 *                        sorted pairKey for the lazy get-or-create.
 *
 * Vocabulary proposals are deliberately absent: vocabulary_terms keeps
 * its own status machine and the decisions surface reads it directly.
 *
 * PERMISSIONS. No new rule is invented here. A question owned by the
 * request tenant (tenant_id set) is ruled by that tenant's authorities
 * admins (workspace admins included); a
 * shared-space question (tenant_id NULL) by a federation steward; a
 * question owned by another tenant 404s before revealing it exists —
 * the same three-way split requireAuthorityMutation applies to records,
 * applied to questions. Mint acceptances additionally pass through
 * requireAuthorityMint, so the gate and the ownership stamp on the new
 * record cannot disagree.
 *
 * `preparePairDecision` composes the filing of a pair's row without
 * running it, for a ruling whose batch must file the row only if it lands
 * (the pair merge).
 *
 * @version v0.9.0
 */

import { and, count, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  comments,
  descriptionEntities,
  descriptionPlaces,
  descriptions,
  entities,
  externalAuthorityLinks,
  places,
  pendingDecisions,
  users,
  vocabularyTerms,
} from "../db/schema";
import {
  ENTITY_ROLES,
  ENTITY_TYPES,
  PLACE_ROLES,
  PLACE_TYPES,
} from "./validation/enums";
import { enqueueDecisionNotifications } from "./notifications.server";
import { evidenceReference } from "./evidence-reference";
import { roleCode } from "./role-options";
import { entityLinkInsertOrFail, placeLinkInsertOrFail } from "./link-roles.server";
import { composeJournalEntry, createSnapshotDiff } from "./stewardship.server";
import type { AuthorityRecordType } from "./authority-ownership.server";
import type { CommentAuthorRole } from "./validation/enums";
import type { Tenant, User } from "../context";
import { retryD1Read, type D1Site } from "./d1-overload";

export const PROPOSAL_TYPES = [
  "person",
  "family",
  "corporate",
  "place",
  "topic",
] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export interface AuthorityProposalPayload {
  /** The source string, verbatim (e.g. the index heading). */
  heading: string;
  proposedType: ProposalType;
  /** Proposed display form (direct order for persons). */
  proposedName: string;
  /** Sort form; falls back to proposedName when absent. */
  sortName?: string;
  /** 'mint' creates a record on accept; 'link' resolves to an existing one. */
  action: "mint" | "link";
  linkTargetType?: AuthorityRecordType;
  linkTargetId?: string;
  /**
   * The producer could NOT settle this one (contradictory or absent
   * grounds). This is the payload's one piece of real structure,
   * because it carries behaviour, not content: an uncertain question
   * offers no one-click answers — it requires judgement, so its only
   * path is the detail page.
   */
  uncertain?: boolean;
  /**
   * What the evidence says the record DOES in the cited document — a
   * code of the federation's document or place roles, whichever the
   * ruled type takes. A proposal that names one is offering a link,
   * not just a name; the ruling turns it into a junction row when the
   * federation's list holds the code approved.
   */
  proposedRole?: string;
  /**
   * Reference code of the record the adjudication quote cites, e.g.
   * "CMD 2928". A code, not an id: the producer read it off the
   * source and has no reason to know our primary keys, so resolution
   * happens at ruling time, inside the tenant's scope.
   */
  evidenceRef?: string;
  /**
   * Reconciliation candidates the pipeline stamped. Display plus
   * confirm-on-accept only — nothing here is a match until a person
   * says it is, and the ruling only accepts one of THESE.
   */
  externalCandidates?: Array<{
    scheme: "lcnaf" | "lcsh" | "geonames";
    id: string;
    label: string;
  }>;
}

export interface DuplicatePairPayload {
  recordType: AuthorityRecordType;
  /** The flagged pair, ids sorted so the key is order-independent. */
  pair: [string, string];
}

export interface ProposalRulingInput {
  ruling: "accepted" | "amended" | "rejected";
  /** Amendments; required fields of the payload win when absent. */
  amendedType?: ProposalType;
  amendedName?: string;
  amendedSortName?: string;
  /** Full-form amendments (the detail view's mint-time fields). */
  amendedNameVariants?: string[];
  amendedPlaceType?: string;
  /** Appended after the provenance line in the record's internal notes. */
  amendedInternalNote?: string;
  note?: string;
  /**
   * Role for the evidence link, as the decision page submits it. When
   * given, even as an empty string, it decides: the proposed role is not
   * used in its place. Absent, as from the queue's one-click accept,
   * which has no selector, the payload's proposedRole is used. Either is
   * read with `roleCode` (trimmed, then matched exactly) and must be
   * approved in the federation's list for the ruled type; no role is
   * assumed, so an acceptance that writes the link with neither is
   * refused.
   */
  linkRole?: string;
  /** True skips creating the evidence link on accept. */
  skipLink?: boolean;
  /**
   * The reconciliation candidate the ruler confirmed. It MUST be one
   * of payload.externalCandidates: the form posts a scheme and an id,
   * and an id that was never proposed is a 400, never a write. A
   * confirmed match is the only way a row reaches
   * external_authority_links from this surface.
   */
  confirmedExternal?: { scheme: string; externalId: string };
}

// ---------------------------------------------------------------------------
// Visibility and counts
// ---------------------------------------------------------------------------

/**
 * The questions the request tenant may see: its own plus the shared
 * ones — the same visibility shape as authorityScope over records.
 */
function decisionScope(tenant: Tenant) {
  return and(
    eq(pendingDecisions.federationId, tenant.federationId),
    or(
      isNull(pendingDecisions.tenantId),
      eq(pendingDecisions.tenantId, tenant.id),
    ),
  );
}

/** Open authority proposals visible to this tenant — the dashboard count. */
export async function countOpenAuthorityProposals(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(pendingDecisions)
    .where(
      and(
        decisionScope(tenant),
        eq(pendingDecisions.kind, "authority-proposal"),
        eq(pendingDecisions.status, "open"),
      ),
    )
    .get();
  return row?.n ?? 0;
}

export type PendingDecisionCounts = {
  authorityProposals: number;
  vocabularyProposals: number;
};

/**
 * Open vocabulary proposals visible to this tenant — same federation
 * scope and `proposed`/not-merged predicate as the vocabulary review
 * queue (migration 0045 federation lift). A single COUNT, no row fetch.
 */
export async function countOpenVocabularyProposals(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(vocabularyTerms)
    .where(
      and(
        eq(vocabularyTerms.status, "proposed"),
        isNull(vocabularyTerms.mergedInto),
        eq(vocabularyTerms.federationId, tenant.federationId),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Both pending-decision counts for the dashboard card, in parallel.
 * The dashboard loader calls it only for those who pass the records or
 * authorities area, and keeps each count only for its own area. Each
 * count is retried while D1 refuses it as overloaded (`retryD1Read`),
 * logged as `pending_authority_proposals` and
 * `pending_vocabulary_proposals` with `site`'s request and context.
 */
export async function loadPendingDecisionCounts(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  site: Omit<D1Site, "read"> = {},
): Promise<PendingDecisionCounts> {
  const [authorityProposals, vocabularyProposals] = await Promise.all([
    retryD1Read(() => countOpenAuthorityProposals(db, tenant), undefined, undefined, {
      ...site,
      read: "pending_authority_proposals",
    }),
    retryD1Read(() => countOpenVocabularyProposals(db, tenant), undefined, undefined, {
      ...site,
      read: "pending_vocabulary_proposals",
    }),
  ]);
  return { authorityProposals, vocabularyProposals };
}

export async function listAuthorityProposals(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  opts: { status: "open" | "ruled"; limit: number; offset: number },
) {
  return db
    .select()
    .from(pendingDecisions)
    .where(
      and(
        decisionScope(tenant),
        eq(pendingDecisions.kind, "authority-proposal"),
        eq(pendingDecisions.status, opts.status),
      ),
    )
    .orderBy(pendingDecisions.createdAt, pendingDecisions.id)
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
}

/**
 * One question, on the same visibility scope as the list — the detail
 * page's read. Returns undefined rather than throwing: the route turns
 * absence into its own 404 so foreign and missing look identical.
 */
export async function getAuthorityProposal(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  id: string,
) {
  return db
    .select()
    .from(pendingDecisions)
    .where(
      and(
        decisionScope(tenant),
        eq(pendingDecisions.kind, "authority-proposal"),
        eq(pendingDecisions.id, id),
      ),
    )
    .get();
}

// ---------------------------------------------------------------------------
// Filing (producers: imports, bulk loads, later extraction)
// ---------------------------------------------------------------------------

export interface ProposalToFile {
  tenantId: string | null;
  payload: AuthorityProposalPayload;
  sourceModule: string;
  sourceRef?: string;
}

/**
 * File a batch of authority proposals. The caller is a server-side
 * producer that has already passed its own gates (an import commit, a
 * load script); this function only stamps and inserts. D1 bind-cap
 * safety: inserts are chunked.
 *
 * `filedByUserId` names the person who filed, when a person did.
 * Machine producers leave it out and the rows carry no filer, exactly
 * as they always have — an import's proposals are nobody's question in
 * particular, and nobody is notified about them. When it IS supplied,
 * the stamp is what later lets a ruling reach the asker, and the
 * filing itself notifies the people who can rule it.
 */
export async function fileAuthorityProposals(
  db: DrizzleD1Database<any>,
  federationId: string,
  proposals: ProposalToFile[],
  now: number = Date.now(),
  filedByUserId?: string | null,
): Promise<number> {
  const CHUNK = 5; // 14 columns per row; stays far under D1's 100 binds
  // Ids are minted up front rather than inside the chunk loop so the
  // notification pass below knows what was created without re-reading.
  const ids = proposals.map(() => crypto.randomUUID());
  for (let i = 0; i < proposals.length; i += CHUNK) {
    const rows = proposals.slice(i, i + CHUNK).map((p, j) => ({
      id: ids[i + j],
      federationId,
      tenantId: p.tenantId,
      kind: "authority-proposal" as const,
      payload: JSON.stringify(p.payload),
      sourceModule: p.sourceModule,
      sourceRef: p.sourceRef ?? null,
      status: "open" as const,
      filedByUserId: filedByUserId ?? null,
      createdAt: now,
    }));
    await db.insert(pendingDecisions).values(rows);
  }
  if (filedByUserId) {
    for (const id of ids) {
      await enqueueDecisionNotifications(db, {
        kind: "proposal_filed",
        decisionId: id,
        actorUserId: filedByUserId,
        now,
      });
    }
  }
  return proposals.length;
}

// ---------------------------------------------------------------------------
// Ruling
// ---------------------------------------------------------------------------

/**
 * Load a question and apply the three-way ownership gate. Foreign-owned
 * questions 404 before anything else; own questions need the
 * authorities area;
 * shared questions need a steward.
 */
async function requireRulableDecision(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  id: string,
  kind: "authority-proposal",
) {
  const { requireAreaWork } = await import("./user-access.server");
  const { requireFederationSteward } = await import("./federation.server");

  const row = await db
    .select()
    .from(pendingDecisions)
    .where(
      and(
        eq(pendingDecisions.id, id),
        eq(pendingDecisions.federationId, tenant.federationId),
        eq(pendingDecisions.kind, kind),
      ),
    )
    .get();

  if (!row || (row.tenantId !== null && row.tenantId !== tenant.id)) {
    throw new Response("Not found", { status: 404 });
  }
  if (row.tenantId === tenant.id) {
    requireAreaWork(user, "authorities");
  } else {
    await requireFederationSteward(db, user, tenant);
  }
  return row;
}

/**
 * Rule an authority proposal. Returns the updated row; on an accepted
 * or amended mint, `resultId` names the record it created and
 * `linkedRef` the description the evidence link reached, if any.
 *
 * The mint path goes through requireAuthorityMint + the agency code
 * prefix resolution (migration 0068), so what gets created is exactly what a hand-mint by the
 * same user in the same workspace would create.
 *
 * TWO THINGS RIDE ALONG WITH AN ACCEPTANCE, both optional and both
 * subordinate to the ruling itself:
 *
 *   the evidence link   The proposal cited a record; accepting says
 *                       the heading belongs in it. The junction row
 *                       is written from the same ruling rather than
 *                       left as a second chore, because a mint whose
 *                       evidence is never attached is a name floating
 *                       free of the document that produced it. It is
 *                       best-effort by design: an evidenceRef that
 *                       names nothing in this tenant's scope leaves
 *                       the mint standing and reports `linkedRef:
 *                       null`. A missing or wrong ROLE, by contrast,
 *                       is a 400: the role is the ruler's or the
 *                       proposal's, approved in the federation's list,
 *                       and none is assumed. An unresolvable reference
 *                       is a gap in the evidence; a missing or bad role
 *                       is a caller error. Skipping the link needs no
 *                       role.
 *
 *   the external match  Only ever one the payload already proposed.
 *                       The form posts scheme + id; anything not in
 *                       payload.externalCandidates is refused, so no
 *                       arbitrary identifier can be written into the
 *                       registry through this door.
 *
 * Both are settled BEFORE anything is minted, so a rejected role or an
 * unrecognised candidate 400s with the queue untouched rather than
 * after a record exists. Every write of an acceptance (the minted
 * record and its journal row, the evidence link, the external match and
 * the ruling itself) then goes in one batch: the evidence link's insert
 * fails the batch when its role is no longer approved at the moment of
 * the write, so a role deprecated after the check leaves nothing
 * written and the question open, and the reviewer gets a 400. On a link proposal the confirmed match is a
 * mutation of the existing target, so it also needs what mutating that
 * record directly needs (`requireAuthorityMutation`: a steward for a
 * shared record); without a match, accepting the link stays with
 * whoever may rule the question.
 */
export async function ruleAuthorityProposal(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  id: string,
  input: ProposalRulingInput,
  now: number = Date.now(),
) {
  const row = await requireRulableDecision(
    db,
    user,
    tenant,
    id,
    "authority-proposal",
  );
  if (row.status !== "open") {
    throw new Response("Already ruled", { status: 409 });
  }

  const payload = JSON.parse(row.payload) as AuthorityProposalPayload;
  const type = input.amendedType ?? payload.proposedType;
  const name = (input.amendedName ?? payload.proposedName).trim();
  const sortName =
    (input.amendedSortName ?? payload.sortName ?? name).trim() || name;
  if (input.ruling !== "rejected" && name.length === 0) {
    throw new Response("A name is required", { status: 400 });
  }

  const nameVariants = (input.amendedNameVariants ?? [])
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const placeType = input.amendedPlaceType?.trim() || undefined;
  const internalNote = input.amendedInternalNote?.trim() || undefined;

  // Which record table the ruling lands in, or null when it lands in
  // none — a rejection, or a topic, whose product is the ruling alone.
  // A link proposal takes its type from the target it names; a mint
  // from the type being ruled.
  const recordType: AuthorityRecordType | null =
    input.ruling === "rejected"
      ? null
      : payload.action === "link"
        ? (payload.linkTargetType ?? null)
        : type === "topic"
          ? null
          : type === "place"
            ? "place"
            : "entity";

  // The description the evidence link would reach, read before anything
  // is minted, so the role it needs is settled first too.
  const evidenceTarget =
    recordType && !input.skipLink ? await findEvidenceDescription(db, tenant, payload.evidenceRef) : null;
  const linkRole = recordType
    ? await resolveLinkRole(db, tenant, recordType, input, payload, evidenceTarget !== null)
    : null;
  const confirmedCandidate = recordType
    ? matchExternalCandidate(payload, input.confirmedExternal)
    : null;

  let resultId: string | null = null;
  // Every write of the ruling goes in one batch, so a refused evidence
  // link leaves nothing of it: no record minted, the question open.
  const writes: BatchItem<"sqlite">[] = [];

  if (input.ruling !== "rejected") {
    if (payload.action === "link") {
      resultId = await resolveLinkTarget(db, tenant, payload);
      // Attaching a confirmed external match writes to the target
      // record itself, so it takes the gate a direct mutation of that
      // record takes: the authorities area on the tenant's own record,
      // a steward on a shared one. Checked before anything is written.
      if (confirmedCandidate && recordType !== null) {
        const { requireAuthorityMutation } = await import("./authority-ownership.server");
        await requireAuthorityMutation(db, user, tenant, recordType, [resultId]);
      }
    } else if (type !== "topic") {
      const mint = await prepareMint(
        db,
        user,
        tenant,
        row.id,
        row.sourceModule,
        row.sourceRef,
        type,
        name,
        sortName,
        { nameVariants, placeType, internalNote },
      );
      resultId = mint.id;
      writes.push(...mint.statements);
    }
    // topic mints nothing: the recorded ruling is the product.
  }

  let linkedRef: string | null = null;
  if (resultId !== null && recordType !== null) {
    if (evidenceTarget && linkRole) {
      writes.push(evidenceLinkInsert(db, tenant.federationId, recordType, resultId, evidenceTarget, linkRole, now));
      linkedRef = evidenceTarget.referenceCode;
    }
    if (confirmedCandidate) {
      writes.push(
        db
        .insert(externalAuthorityLinks)
        .values({
          id: crypto.randomUUID(),
          federationId: row.federationId,
          recordType,
          recordId: resultId,
          scheme: confirmedCandidate.scheme,
          externalId: confirmedCandidate.id,
          matchedLabel: confirmedCandidate.label,
          matchedBy: "reconciled-confirmed",
          decisionId: row.id,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing(),
      );
    }
  }

  writes.push(
    db
    .update(pendingDecisions)
    .set({
      status: "ruled",
      ruling: input.ruling,
      rulingNote: input.note?.trim() || null,
      resultId,
      ruledBy: user.id,
      ruledAt: now,
      // amendments become part of the record the trail preserves
      payload: JSON.stringify({
        ...payload,
        ...(input.ruling === "amended"
          ? { proposedType: type, proposedName: name, sortName }
          : {}),
      }),
    })
    .where(eq(pendingDecisions.id, row.id)),
  );
  try {
    await db.batch(writes as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (err) {
    // The evidence link's role was deprecated after `resolveLinkRole`
    // read it: the batch wrote nothing, and the question stays open.
    const { isRefusedLinkRole } = await import("./link-roles.server");
    if (isRefusedLinkRole(err)) {
      throw new Response(`The ${recordType} role ${linkRole} is no longer approved`, { status: 400 });
    }
    throw err;
  }

  // The ruling has committed; the filer can now be told about it.
  await enqueueDecisionNotifications(db, {
    kind: "decision_ruled",
    decisionId: id,
    actorUserId: user.id,
    now,
  });

  return { id: row.id, ruling: input.ruling, resultId, linkedRef, linkedRole: linkedRef ? linkRole : null };
}

/**
 * The role the evidence link will carry: the ruler's `linkRole` when the
 * ruling submits one, empty included, else the payload's `proposedRole`. It must be approved in the federation's
 * list for the ruled record type (`readRoleVocabulary`); Fisqua assumes
 * no role of its own. When the link will be written (`required`), a
 * missing role is a 400 as well. When it will not, a role the ruler
 * posted is still checked, so a caller never gets silence for a role
 * the list refuses, and the payload's role is not.
 */
async function resolveLinkRole(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  recordType: AuthorityRecordType,
  input: ProposalRulingInput,
  payload: AuthorityProposalPayload,
  required: boolean,
): Promise<string | null> {
  // A submitted role decides, empty included; only a ruling that submits
  // none (the queue's one-click accept) takes the proposal's.
  const submitted = input.linkRole !== undefined;
  const posted = roleCode(input.linkRole);
  const role = required
    ? submitted
      ? posted
      : roleCode(payload.proposedRole)
    : input.skipLink
      ? ""
      : posted;
  if (!role) {
    if (required) throw new Response(`A ${recordType} role is required`, { status: 400 });
    return null;
  }
  // The same condition the link writes carry (`link-roles.server.ts`),
  // read first here so a refused role mints nothing.
  const { isRoleApproved } = await import("./link-roles.server");
  const approved = await retryD1Read(
    () => isRoleApproved(db, tenant.federationId, recordType === "place" ? "place_role" : "entity_role", role),
    undefined,
    undefined,
    { read: "decision_link_role" },
  );
  if (!approved) {
    throw new Response(`Unknown ${recordType} role: ${role}`, { status: 400 });
  }
  return role;
}

/**
 * The confirmed reconciliation candidate, or null when none was
 * confirmed. The form hands back a scheme and an id; only a pair the
 * PAYLOAD already carries is honoured, so the registry can never
 * receive an identifier nobody proposed. Absence of candidates is not
 * a special case — an empty list matches nothing, which is a 400 for
 * any confirmation sent against it.
 */
function matchExternalCandidate(
  payload: AuthorityProposalPayload,
  confirmed: ProposalRulingInput["confirmedExternal"],
): { scheme: string; id: string; label: string } | null {
  if (!confirmed) return null;
  const match = (payload.externalCandidates ?? []).find(
    (candidate) =>
      candidate.scheme === confirmed.scheme && candidate.id === confirmed.externalId,
  );
  if (!match) {
    throw new Response("Unknown external candidate", { status: 400 });
  }
  return match;
}

/**
 * The description the evidence cites, read in the request tenant's
 * scope, or null when there is nothing to attach the record to.
 *
 * The reference code is resolved inside the request tenant's scope,
 * which is also the decision's: a foreign-owned question 404s at the
 * gate, so by the time this runs the decision is either this tenant's
 * own or a shared-space one being ruled from this tenant's session.
 * Another tenant's "CMD 2928" is therefore not a match — it is simply
 * absent, and the mint stands with no link.
 */
async function findEvidenceDescription(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  evidenceRef: string | undefined,
): Promise<{ id: string; referenceCode: string } | null> {
  // The pages read the code the same way (`evidenceReference`), so they
  // offer the link controls exactly when this finds a description.
  const ref = evidenceReference(evidenceRef);
  if (!ref) return null;
  return (
    (await db
      .select({ id: descriptions.id, referenceCode: descriptions.referenceCode })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.referenceCode, ref)))
      .get()) ?? null
  );
}

/**
 * The statement attaching the ruled record to the evidence description
 * under `role`, for the ruling's batch. It carries the role check of
 * every link write (`link-roles.server.ts`) and fails the batch when the
 * role is not approved at the moment of the write; a duplicate of an
 * existing (description, record, role) link is ignored, and that link
 * holds the reference.
 */
function evidenceLinkInsert(
  db: DrizzleD1Database<any>,
  federationId: string,
  recordType: AuthorityRecordType,
  recordId: string,
  target: { id: string; referenceCode: string },
  role: string,
  now: number,
): BatchItem<"sqlite"> {
  const base = { id: crypto.randomUUID(), descriptionId: target.id, role, roleNote: null, roleRaw: null, createdAt: now };
  return recordType === "place"
    ? placeLinkInsertOrFail(db, federationId, { ...base, placeId: recordId })
    : entityLinkInsertOrFail(db, federationId, { ...base, entityId: recordId });
}

/** Validate a link proposal's target inside the tenant's visible scope. */
async function resolveLinkTarget(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  payload: AuthorityProposalPayload,
): Promise<string> {
  const { authorityScope } = await import("./authority-ownership.server");
  if (!payload.linkTargetId || !payload.linkTargetType) {
    throw new Response("Link proposal without a target", { status: 400 });
  }
  const table = payload.linkTargetType === "entity" ? entities : places;
  const target = await db
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        authorityScope(table, tenant.federationId, tenant.id),
        eq(table.id, payload.linkTargetId),
      ),
    )
    .get();
  if (!target) {
    throw new Response("Link target not found", { status: 404 });
  }
  return target.id;
}

/**
 * The record a ruling mints, and the statements that write it with its
 * journal row, for the ruling's batch. The code and the owner are read
 * here; nothing is written until the batch runs.
 */
async function prepareMint(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  decisionId: string,
  sourceModule: string,
  sourceRef: string | null,
  type: Exclude<ProposalType, "topic">,
  name: string,
  sortName: string,
  extras: {
    nameVariants?: string[];
    placeType?: string;
    internalNote?: string;
  } = {},
): Promise<{ id: string; statements: BatchItem<"sqlite">[] }> {
  const { requireAuthorityMint } = await import(
    "./authority-ownership.server"
  );
  const { resolveAuthorityCodePrefix, generateUniqueCode } = await import(
    "./codes.server"
  );

  const ownerTenantId = await requireAuthorityMint(db, user, tenant);
  const now = Date.now();
  const id = crypto.randomUUID();
  const provenance =
    `Minted from pending decision ${decisionId}` +
    (sourceRef ? ` (${sourceModule}: ${sourceRef})` : ` (${sourceModule})`);
  const internalNotes = extras.internalNote
    ? `${provenance}\n${extras.internalNote}`
    : provenance;
  const variantsJson = JSON.stringify(extras.nameVariants ?? []);

  if (type === "place") {
    const prefix = await resolveAuthorityCodePrefix(
      db,
      "place",
      tenant.federationId,
      ownerTenantId,
    );
    const code = await generateUniqueCode(db, prefix, places, places.placeCode);
    const values = {
      id,
      federationId: tenant.federationId,
      tenantId: ownerTenantId,
      placeCode: code,
      label: name,
      displayName: name,
      placeType:
        extras.placeType && (PLACE_TYPES as readonly string[]).includes(extras.placeType)
          ? (extras.placeType as (typeof PLACE_TYPES)[number])
          : null,
      nameVariants: variantsJson,
      legacyIds: "[]",
      internalNotes,
      createdAt: now,
      updatedAt: now,
    };
    return {
      id,
      statements: [
        db.insert(places).values(values),
        composeJournalEntry(db, {
          recordId: id,
          recordType: "place",
          userId: user.id,
          kind: "create",
          diff: createSnapshotDiff(values as Record<string, unknown>),
          note: provenance,
          now,
        }),
      ],
    };
  }

  if (!(ENTITY_TYPES as readonly string[]).includes(type)) {
    throw new Response(`Unknown entity type: ${type}`, { status: 400 });
  }
  const prefix = await resolveAuthorityCodePrefix(
    db,
    "entity",
    tenant.federationId,
    ownerTenantId,
  );
  const code = await generateUniqueCode(
    db,
    prefix,
    entities,
    entities.entityCode,
  );
  const values = {
    id,
    federationId: tenant.federationId,
    tenantId: ownerTenantId,
    entityCode: code,
    displayName: name,
    sortName,
    entityType: type,
    nameVariants: variantsJson,
    legacyIds: "[]",
    internalNotes,
    createdAt: now,
    updatedAt: now,
  };
  return {
    id,
    statements: [
      db.insert(entities).values(values),
      composeJournalEntry(db, {
        recordId: id,
        recordType: "entity",
        userId: user.id,
        kind: "create",
        diff: createSnapshotDiff(values as Record<string, unknown>),
        note: provenance,
        now,
      }),
    ],
  };
}


// ---------------------------------------------------------------------------
// Comments — a comment, an author, and a date
//
// Decision threads live in the platform's one `comments` table
// (decision_id target, migration 0071). These two functions are the
// decision-domain veneer over that storage: they own the fields a
// decision comment uses (prose, one quoted passage with its reference,
// an epistemic note) and the tenant stamp copied from the decision.
// Volume-surface policies (resolve, regions) do not apply here.
// ---------------------------------------------------------------------------

export interface DecisionCommentView {
  id: string;
  /** Display name: the user's, or the label ("Fisqua", a pipeline). */
  author: string;
  /** The author's user id; null for label (pipeline) authors. */
  authorId: string | null;
  /** Role snapshot at post time; null for label authors. */
  role: string | null;
  /** True for agency/label authors — renders the System pill. */
  isSystem: boolean;
  body: string;
  /** One quoted passage, set on parchment, with its reference. */
  quote: string | null;
  quoteRef: string | null;
  /** Epistemic qualifier, demoted below the prose. */
  note: string | null;
  createdAt: number;
  /** When the author last revised the prose; null if never edited. */
  editedAt: number | null;
}

/**
 * Add a comment to a decision. `author` is either a signed-in user
 * (with their role snapshotted at post time) or a plain label for
 * non-user authors — the filing pipeline passes "Fisqua". Callers gate
 * access; this only writes.
 */
export async function addDecisionComment(
  db: DrizzleD1Database<any>,
  decisionId: string,
  author: { userId: string; role?: CommentAuthorRole } | { label: string },
  body: string,
  extras: { quote?: string; quoteRef?: string; note?: string } = {},
  now: number = Date.now(),
): Promise<void> {
  const decision = await db
    .select({ tenantId: pendingDecisions.tenantId })
    .from(pendingDecisions)
    .where(eq(pendingDecisions.id, decisionId))
    .get();
  if (!decision) {
    throw new Response("Not found", { status: 404 });
  }
  await db.insert(comments).values({
    id: crypto.randomUUID(),
    tenantId: decision.tenantId,
    decisionId,
    authorId: "userId" in author ? author.userId : null,
    authorLabel: "label" in author ? author.label : null,
    authorRole: "userId" in author ? (author.role ?? null) : null,
    text: body,
    quote: extras.quote ?? null,
    quoteRef: extras.quoteRef ?? null,
    note: extras.note ?? null,
    createdAt: now,
    updatedAt: now,
  });
  // Only a person's comment notifies. Pipelines are silent on every
  // event, so a label-authored comment ends here.
  if ("userId" in author) {
    await enqueueDecisionNotifications(db, {
      kind: "decision_comment",
      decisionId,
      actorUserId: author.userId,
      now,
    });
  }
}

/**
 * Comment threads for a set of decisions, oldest first, author names
 * resolved, tombstones excluded. One query however many decisions the
 * page shows.
 */
export async function listDecisionComments(
  db: DrizzleD1Database<any>,
  decisionIds: string[],
): Promise<Record<string, DecisionCommentView[]>> {
  if (decisionIds.length === 0) return {};
  const { inArray } = await import("drizzle-orm");
  const rows = await db
    .select({
      id: comments.id,
      decisionId: comments.decisionId,
      authorId: comments.authorId,
      authorLabel: comments.authorLabel,
      authorRole: comments.authorRole,
      authorName: users.name,
      authorEmail: users.email,
      body: comments.text,
      quote: comments.quote,
      quoteRef: comments.quoteRef,
      note: comments.note,
      createdAt: comments.createdAt,
      editedAt: comments.editedAt,
    })
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(
      and(inArray(comments.decisionId, decisionIds), isNull(comments.deletedAt)),
    )
    .orderBy(comments.createdAt, comments.id)
    .all();
  const out: Record<string, DecisionCommentView[]> = {};
  for (const r of rows) {
    if (!r.decisionId) continue;
    (out[r.decisionId] ??= []).push({
      id: r.id,
      author: r.authorLabel ?? r.authorName ?? r.authorEmail ?? "",
      authorId: r.authorId,
      role: r.authorRole,
      isSystem: r.authorLabel !== null,
      body: r.body,
      quote: r.quote,
      quoteRef: r.quoteRef,
      note: r.note,
      createdAt: r.createdAt,
      editedAt: r.editedAt,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Duplicate pairs (0072: a pair is a decision, filed lazily on first
// durable contact — a comment, or a ruling — and ruled kept_both /
// merged from there)
// ---------------------------------------------------------------------------

/** Order-independent key for a pair, used by scan subtraction. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * The tenant stamp a NEW pair row should carry — the 0067 ownership
 * shape applied to a pair instead of one record. Both sorted ids are
 * read from the record table `recordType` names; the pair is the
 * request tenant's own question only when BOTH records are. The
 * mutation gate the caller already ran has 404'd any record owned by a
 * THIRD tenant, so what is left here is own/own versus anything
 * touching a shared record.
 */
async function resolvePairTenantStamp(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  recordType: AuthorityRecordType,
  a: string,
  b: string,
): Promise<string | null> {
  const table = recordType === "place" ? places : entities;
  const rows = await db
    .select({ id: table.id, tenantId: table.tenantId })
    .from(table)
    .where(
      and(
        eq(table.federationId, tenant.federationId),
        inArray(table.id, [a, b]),
      ),
    )
    .all();
  const bothOwn = rows.length === 2 && rows.every((r) => r.tenantId === tenant.id);
  return bothOwn ? tenant.id : null;
}

/**
 * Find a pair's decision row by its sorted pairKey, or file a fresh
 * OPEN one. Shared by `getOrCreatePairDecision` and `rulePairKeepBoth`
 * so the pair mutation gate is charged exactly once per call — this
 * helper assumes the caller has already run `requireAuthorityMutation`.
 */
async function findOrCreatePairRow(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  recordType: AuthorityRecordType,
  idA: string,
  idB: string,
  now: number,
): Promise<typeof pendingDecisions.$inferSelect> {
  const [a, b] = idA < idB ? [idA, idB] : [idB, idA];
  const sourceRef = pairKey(a, b);

  const existing = await db
    .select()
    .from(pendingDecisions)
    .where(
      and(
        eq(pendingDecisions.federationId, tenant.federationId),
        eq(pendingDecisions.kind, "duplicate-pair"),
        eq(pendingDecisions.sourceRef, sourceRef),
      ),
    )
    .get();
  if (existing) return existing;

  const tenantId = await resolvePairTenantStamp(db, tenant, recordType, a, b);
  const payload: DuplicatePairPayload = { recordType, pair: [a, b] };
  // Two concurrent first-contacts can both miss the lookup above; the
  // 0073 unique index makes the second insert a no-op, and the
  // key-based re-select below returns whichever row won.
  await db
    .insert(pendingDecisions)
    .values({
      id: crypto.randomUUID(),
      federationId: tenant.federationId,
      tenantId,
      kind: "duplicate-pair",
      payload: JSON.stringify(payload),
      sourceModule: "duplicate-scan",
      sourceRef,
      status: "open",
      filedByUserId: user.id,
      createdAt: now,
    })
    .onConflictDoNothing();
  return (await db
    .select()
    .from(pendingDecisions)
    .where(
      and(
        eq(pendingDecisions.federationId, tenant.federationId),
        eq(pendingDecisions.kind, "duplicate-pair"),
        eq(pendingDecisions.sourceRef, sourceRef),
      ),
    )
    .get())!;
}

/**
 * A pair's decision row for a ruling that writes in one batch: gated as
 * `getOrCreatePairDecision` is, the row read by its key, and, when the
 * pair has none, the INSERT that files it open, composed and not run.
 * The caller puts `insert` in its batch ahead of the statements that rule
 * the row by `key`, so a batch that fails leaves no row behind, and reads
 * the row back by `key` once the batch has landed.
 *
 * `asRead` is the condition that the pair's row is still as read: none
 * when none was read, or the row read, still open. A request that files
 * or rules the pair in between (a "keep both", say) makes it false. The
 * caller guards its batch with it, so such a batch fails whole and its
 * ruling never overwrites the other, and asks `stillAsRead` after a
 * failed batch to answer it as a conflict.
 */
export async function preparePairDecision(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  recordType: AuthorityRecordType,
  idA: string,
  idB: string,
  now: number = Date.now(),
): Promise<{
  existing: typeof pendingDecisions.$inferSelect | undefined;
  insert: BatchItem<"sqlite"> | null;
  key: SQL;
  asRead: SQL;
  stillAsRead: () => Promise<boolean>;
}> {
  const { requireAuthorityMutation } = await import(
    "./authority-ownership.server"
  );
  await requireAuthorityMutation(db, user, tenant, recordType, [idA, idB]);
  const [a, b] = idA < idB ? [idA, idB] : [idB, idA];
  const sourceRef = pairKey(a, b);
  const key = and(
    eq(pendingDecisions.federationId, tenant.federationId),
    eq(pendingDecisions.kind, "duplicate-pair"),
    eq(pendingDecisions.sourceRef, sourceRef),
  )!;
  const existing = await db.select().from(pendingDecisions).where(key).get();
  const asRead = existing
    ? sql`EXISTS (SELECT 1 FROM ${pendingDecisions} WHERE ${pendingDecisions.id} = ${existing.id} AND ${pendingDecisions.status} = 'open')`
    : sql`NOT EXISTS (SELECT 1 FROM ${pendingDecisions} WHERE ${key})`;
  const stillAsRead = async () =>
    (await db.select({ ok: sql<number>`CASE WHEN ${asRead} THEN 1 ELSE 0 END` }).from(sql`(SELECT 1)`).get())?.ok === 1;
  if (existing) return { existing, insert: null, key, asRead, stillAsRead };
  const tenantId = await resolvePairTenantStamp(db, tenant, recordType, a, b);
  const payload: DuplicatePairPayload = { recordType, pair: [a, b] };
  const insert = db
    .insert(pendingDecisions)
    .values({
      id: crypto.randomUUID(),
      federationId: tenant.federationId,
      tenantId,
      kind: "duplicate-pair",
      payload: JSON.stringify(payload),
      sourceModule: "duplicate-scan",
      sourceRef,
      status: "open",
      filedByUserId: user.id,
      createdAt: now,
    })
    .onConflictDoNothing();
  return { existing: undefined, insert, key, asRead, stillAsRead };
}

/**
 * Get a pair's decision row, filing it OPEN on first contact. Gated
 * exactly like a mutation of the pair itself
 * (`requireAuthorityMutation`'s pair rule), because filing the question
 * is already a judgement about both records. Idempotent by
 * construction: a second call, either id order, returns the SAME row
 * — ruled or still open — because the lookup key is the sorted
 * pairKey rather than a fresh insert.
 */
export async function getOrCreatePairDecision(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  recordType: AuthorityRecordType,
  idA: string,
  idB: string,
  now: number = Date.now(),
): Promise<typeof pendingDecisions.$inferSelect> {
  const { requireAuthorityMutation } = await import(
    "./authority-ownership.server"
  );
  await requireAuthorityMutation(db, user, tenant, recordType, [idA, idB]);
  return findOrCreatePairRow(db, user, tenant, recordType, idA, idB, now);
}

/**
 * Rule a pair "not a duplicate" — the persisted `kept_both` the scan
 * subtracts. Gates and files the row exactly as
 * `getOrCreatePairDecision` does (the two share `findOrCreatePairRow`
 * so the gate is not charged twice), then rules it in the same batch
 * as the `separate` ledger entry the duplicates worklist writes — that
 * dual write used to live in the route action; it lives here now, so
 * every caller of this function gets it for free.
 */
export async function rulePairKeepBoth(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  recordType: AuthorityRecordType,
  idA: string,
  idB: string,
  reason: string | null,
  now: number = Date.now(),
): Promise<void> {
  const { requireAuthorityMutation } = await import(
    "./authority-ownership.server"
  );
  const { logAuthorityOperation } = await import(
    "./authority-operations.server"
  );
  await requireAuthorityMutation(db, user, tenant, recordType, [idA, idB]);
  const row = await findOrCreatePairRow(
    db,
    user,
    tenant,
    recordType,
    idA,
    idB,
    now,
  );

  if (row.status === "ruled") {
    throw new Response("Already ruled", { status: 409 });
  }

  await db.batch([
    db
      .update(pendingDecisions)
      .set({
        status: "ruled",
        ruling: "kept_both",
        rulingNote: reason,
        ruledBy: user.id,
        ruledAt: now,
      })
      .where(eq(pendingDecisions.id, row.id)),
    logAuthorityOperation(db, {
      federationId: tenant.federationId,
      recordType,
      operation: "separate",
      sourceId: idA,
      targetId: idB,
      userId: user.id,
      detail: { reason },
      now,
    }),
  ] as any);

  await enqueueDecisionNotifications(db, {
    kind: "decision_ruled",
    decisionId: row.id,
    actorUserId: user.id,
    now,
  });
}

/**
 * The ruled pairs the scan must subtract, as pairKey() strings. Only
 * ruled rows subtract — an open pair row (filed lazily by a comment or
 * by `getOrCreatePairDecision`) must keep appearing in the scan until
 * someone rules it. Rulings are visible on the same scope as the
 * questions: the tenant's own plus shared-space ones. Named for the
 * 0072 shape, where a pair row can exist before it is ruled —
 * "dismissed" no longer describes what the set holds.
 */
export async function ruledPairKeys(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  recordType: AuthorityRecordType,
): Promise<Set<string>> {
  const rows = await db
    .select({ payload: pendingDecisions.payload })
    .from(pendingDecisions)
    .where(
      and(
        decisionScope(tenant),
        eq(pendingDecisions.kind, "duplicate-pair"),
        eq(pendingDecisions.status, "ruled"),
      ),
    )
    .all();
  const keys = new Set<string>();
  for (const r of rows) {
    const p = JSON.parse(r.payload) as DuplicatePairPayload;
    if (p.recordType === recordType) keys.add(pairKey(p.pair[0], p.pair[1]));
  }
  return keys;
}

// @version v0.9.0
