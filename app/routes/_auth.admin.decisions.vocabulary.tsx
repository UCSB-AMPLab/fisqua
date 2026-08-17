/**
 * Pending Decisions — Vocabulary tab
 *
 * The reviewer-only backlog of draft vocabulary terms awaiting
 * approval, moved here from `/admin/vocabularies/review` (which now
 * redirects) so that every question a workspace has to answer lives on
 * one surface. It shows each draft with its proposed label, any linked
 * descriptions, and inline approve / reject actions. Rejections
 * surface the inline panel so the reviewer can capture a reason
 * without leaving the queue.
 *
 * The move is a move, not a rewrite. The loader, the action, and the
 * `vocabulary_terms` status machine they drive — proposed → approved,
 * proposed → deprecated on rejection (never deleted, never with the
 * entity foreign keys nulled), merge into a surviving term — are
 * exactly what the page carried before. Two things follow from the new
 * address rather than from any change of behaviour: the
 * `vocabulary_hub` capability gate that the vocabularies hub layout
 * used to supply is now stated here, because this route no longer
 * nests inside it; and the page renders an `h2`, since the surface
 * layout owns the `h1`.
 *
 * Authority scope is the federation (migrations 0045-0048). The merge
 * action's primaryFunctionId reassignment and post-merge entity-count
 * subqueries are scoped to `tenant.federationId`, and every vocab
 * mutation (approve/reject/merge) carries a federation predicate. The
 * queue is federation-scoped: a proposal surfaces in its federation via
 * vocabulary_terms.federation_id, which replaces the former
 * proposer-tenant visibility rule (and its orphan-proposal fallback).
 *
 * Duplicates-vocabulary design round: above the plain table, the
 * loader now runs `computeVocabularyNearMatches` over this page's
 * proposed terms against the federation's approved vocabulary and
 * surfaces the best matches (capped at twelve) as `VocabularyTermCard`s
 * — a proposed term sitting next to the already-approved form it
 * probably duplicates, with a one-click "keep as its own term" or
 * "merge into existing" ruling. Matched terms are pulled out of the
 * plain table so the same term never appears twice; a match beyond the
 * cap stays a table row rather than silently disappearing. "Keep"
 * routes through the existing approve intent (extended to fold a
 * given reason into the term's notes); "merge" routes through the
 * existing merge intent (extended so that merging INTO a still-proposed
 * term also approves it — a merge must never leave its survivor
 * unapproved — and so a given reason rides along in the ledger row's
 * detail).
 *
 * @version v0.7.0
 */

import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronLeft, Check, X } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { RejectInlinePanel } from "~/components/admin/reject-inline-panel";
import { VocabularyTermCard } from "~/components/admin/vocabulary-term-card";
import { DismissDialog } from "~/components/admin/dismiss-dialog";
import { PairMergeDialog } from "~/components/admin/pair-merge-dialog";
import { SaveFeedbackBanner } from "~/components/admin/save-feedback";
import { useFormatters } from "~/lib/use-formatters";
import { escapeLike } from "~/lib/sql-utils";
import type { VocabularyNearMatch } from "~/lib/authority-duplicates.server";
import type { Route } from "./+types/_auth.admin.decisions.vocabulary";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProposedTerm {
  id: string;
  canonical: string;
  category: string | null;
  entityCount: number;
  proposedByName: string | null;
  createdAt: number;
}

/** Near-match cards rendered above the table are capped, per the
 *  design round's "no silent drop" rule — the rest stay table rows. */
const MAX_VOCAB_CARDS = 12;

/** What the vocab-card fetcher hands back on approve/merge submission. */
type VocabActionResult =
  | { ok: true; action: "approved" | "merged" }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, isNull, desc, sql } = await import("drizzle-orm");
  const { vocabularyTerms, users } = await import("~/db/schema");
  const { computeVocabularyNearMatches } = await import(
    "~/lib/authority-duplicates.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  // Stated here because the route no longer nests inside the
  // vocabularies hub layout, which used to supply this gate.
  requireCapability(tenant, "vocabulary_hub");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const url = new URL(request.url);

  // JSON search API for merge dialog (reuse same pattern as functions listing)
  if (url.searchParams.get("intent") === "search-terms") {
    const { like } = await import("drizzle-orm");
    const q = url.searchParams.get("q")?.trim() || "";
    const excludeId = url.searchParams.get("exclude") || "";
    const conditions = [
      eq(vocabularyTerms.federationId, tenant.federationId),
      like(vocabularyTerms.canonical, `%${escapeLike(q)}%`),
      isNull(vocabularyTerms.mergedInto),
      eq(vocabularyTerms.status, "approved"),
    ];
    if (excludeId) {
      conditions.push(sql`${vocabularyTerms.id} != ${excludeId}`);
    }
    const results = await db
      .select({
        id: vocabularyTerms.id,
        displayName: vocabularyTerms.canonical,
        code: vocabularyTerms.category,
      })
      .from(vocabularyTerms)
      .where(and(...conditions))
      .limit(10)
      .all();
    return Response.json(results);
  }

  const page = Math.max(
    1,
    parseInt(url.searchParams.get("page") || "1", 10)
  );
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  // Queue visibility: a proposal belongs to its FEDERATION (migration
  // 0045). The proposer-tenant scoping this replaced is superseded by
  // vocabulary_terms.federation_id, which every term carries (including
  // orphan proposals whose proposedBy went null after a user deletion),
  // so no or()/isNull fallback is needed. The users leftJoin below stays
  // only to surface the proposer name.
  const proposedVisibleHere = and(
    eq(vocabularyTerms.status, "proposed"),
    isNull(vocabularyTerms.mergedInto),
    eq(vocabularyTerms.federationId, tenant.federationId)
  );

  // Count total proposed terms visible to this tenant
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(vocabularyTerms)
    .leftJoin(users, eq(vocabularyTerms.proposedBy, users.id))
    .where(proposedVisibleHere)
    .all();

  // Fetch proposed terms with proposer name
  const rows = await db
    .select({
      id: vocabularyTerms.id,
      canonical: vocabularyTerms.canonical,
      category: vocabularyTerms.category,
      entityCount: vocabularyTerms.entityCount,
      proposedByName: users.name,
      createdAt: vocabularyTerms.createdAt,
    })
    .from(vocabularyTerms)
    .leftJoin(users, eq(vocabularyTerms.proposedBy, users.id))
    .where(proposedVisibleHere)
    .orderBy(desc(vocabularyTerms.createdAt))
    .limit(pageSize)
    .offset(offset)
    .all();

  // Vocabulary near-match cards (duplicates-vocabulary design round):
  // the federation's approved vocabulary, matched against this page's
  // proposed terms. Capped at MAX_VOCAB_CARDS; a match beyond the cap
  // stays a normal table row instead of disappearing.
  const approvedTerms = await db
    .select({
      id: vocabularyTerms.id,
      canonical: vocabularyTerms.canonical,
      entityCount: vocabularyTerms.entityCount,
    })
    .from(vocabularyTerms)
    .where(
      and(
        eq(vocabularyTerms.status, "approved"),
        isNull(vocabularyTerms.mergedInto),
        eq(vocabularyTerms.federationId, tenant.federationId),
      ),
    )
    .all();

  const proposedLite = rows.map((r) => ({
    id: r.id,
    canonical: r.canonical,
    entityCount: r.entityCount,
  }));
  const vocabMatches: VocabularyNearMatch[] = computeVocabularyNearMatches(
    proposedLite,
    approvedTerms,
  ).slice(0, MAX_VOCAB_CARDS);
  const cardedIds = new Set(vocabMatches.map((m) => m.proposed.id));

  return {
    // Carded matches are pulled out of the table so a term never
    // appears twice.
    terms: (rows as ProposedTerm[]).filter((t) => !cardedIds.has(t.id)),
    total,
    page,
    totalPages: Math.ceil(total / pageSize),
    vocabMatches,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { authorityScope } = await import("~/lib/authority-ownership.server");
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const { vocabularyTerms, entities, changelog } = await import(
    "~/db/schema"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  // Stated here because the route no longer nests inside the
  // vocabularies hub layout, which used to supply this gate.
  requireCapability(tenant, "vocabulary_hub");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Authority mutation gate (ruled 2026-07-08): approving, rejecting, or
  // merging proposed terms is a canonical vocabulary mutation subject to
  // federation steward review; the review queue is steward-only.
  // Member-tenant PROPOSE is currently unreachable (the only propose
  // sites live inside the steward-gated entity create/update intents)
  // and defers to the entities/places propose-for-review follow-up
  // (ruled 2026-07-08). Behaviour-neutral today.
  const { requireFederationSteward } = await import("~/lib/federation.server");
  await requireFederationSteward(db, user, tenant);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "approve": {
      const termId = formData.get("termId") as string;
      const category = (formData.get("category") as string)?.trim() || null;
      // The vocabulary card's "keep as its own term" ruling carries an
      // optional reason; the plain table's approve has no reason field
      // and reads this as empty. A given reason is never dropped — it
      // rides into the term's notes, same append shape as rejection.
      const reason = ((formData.get("reason") as string) || "").trim();
      if (!termId) return { ok: false as const, error: "missing_id" };

      const now = Math.floor(Date.now() / 1000);
      const updates: Record<string, unknown> = {
        status: "approved",
        reviewedBy: user.id,
        reviewedAt: now,
        updatedAt: now,
      };
      if (category) {
        updates.category = category;
      }
      if (reason) {
        const term = await db
          .select({ notes: vocabularyTerms.notes })
          .from(vocabularyTerms)
          .where(
            and(
              eq(vocabularyTerms.id, termId),
              eq(vocabularyTerms.federationId, tenant.federationId),
            ),
          )
          .get();
        const existingNotes = term?.notes || "";
        updates.notes = existingNotes ? `${existingNotes}\n${reason}` : reason;
      }

      await db
        .update(vocabularyTerms)
        .set(updates)
        .where(
          and(
            eq(vocabularyTerms.id, termId),
            eq(vocabularyTerms.federationId, tenant.federationId)
          )
        );

      // Changelog entry
      await db.insert(changelog).values({
        id: crypto.randomUUID(),
        recordId: termId,
        recordType: "vocabulary_term",
        userId: user.id,
        note: "Approved proposed term",
        diff: JSON.stringify({ status: { old: "proposed", new: "approved" } }),
        createdAt: now,
      });

      return { ok: true as const, action: "approved" };
    }

    case "reject": {
      const termId = formData.get("termId") as string;
      const reason = (formData.get("reason") as string)?.trim() || "";
      if (!termId) return { ok: false as const, error: "missing_id" };

      const now = Math.floor(Date.now() / 1000);

      // Fetch current term for notes append
      const term = await db
        .select({ notes: vocabularyTerms.notes })
        .from(vocabularyTerms)
        .where(
          and(
            eq(vocabularyTerms.id, termId),
            eq(vocabularyTerms.federationId, tenant.federationId)
          )
        )
        .get();

      const existingNotes = term?.notes || "";
      const rejectNote = reason
        ? `Rejected: ${reason}`
        : "Rejected (no reason given)";
      const updatedNotes = existingNotes
        ? `${existingNotes}\n${rejectNote}`
        : rejectNote;

      // Deprecate -- do NOT delete, do NOT null entity FKs
      await db
        .update(vocabularyTerms)
        .set({
          status: "deprecated",
          reviewedBy: user.id,
          reviewedAt: now,
          notes: updatedNotes,
          updatedAt: now,
        })
        .where(
          and(
            eq(vocabularyTerms.id, termId),
            eq(vocabularyTerms.federationId, tenant.federationId)
          )
        );

      // Changelog entry
      await db.insert(changelog).values({
        id: crypto.randomUUID(),
        recordId: termId,
        recordType: "vocabulary_term",
        userId: user.id,
        note: `Rejected: ${reason}`,
        diff: JSON.stringify({
          status: { old: "proposed", new: "deprecated" },
        }),
        createdAt: now,
      });

      return { ok: true as const, action: "rejected" };
    }

    case "merge": {
      const { logAuthorityOperation } = await import(
        "~/lib/authority-operations.server"
      );
      const sourceId = formData.get("sourceId") as string;
      const targetId = formData.get("targetId") as string;
      // The vocabulary card's merge dialog carries an optional reason
      // (why these are the same subject); a given reason is never
      // dropped — it rides into the ledger row's detail alongside
      // movedLinks.
      const reason = ((formData.get("reason") as string) || "").trim();
      if (!sourceId || !targetId)
        return { ok: false as const, error: "missing_ids" };

      const now = Math.floor(Date.now() / 1000);

      // Count the entities the reassignment below will move BEFORE the
      // batch — the ledger's movedLinks must describe this merge, and the
      // predicate matches the UPDATE's exactly.
      const [{ count: movedLinks }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .where(
          and(
            authorityScope(entities, tenant.federationId, tenant.id),
            eq(entities.primaryFunctionId, sourceId)
          )
        )
        .all();

      // Direction flip (duplicates-vocabulary design round): the
      // vocabulary card lets the admin pick the still-PROPOSED form as
      // the survivor. A merge must never leave its survivor unapproved,
      // so when the target is proposed, the same batch approves it.
      // Read before the batch, since the batch's own statements do not
      // see each other's writes.
      const targetTerm = await db
        .select({ status: vocabularyTerms.status })
        .from(vocabularyTerms)
        .where(
          and(
            eq(vocabularyTerms.id, targetId),
            eq(vocabularyTerms.federationId, tenant.federationId),
          ),
        )
        .get();
      const targetNeedsApproval = targetTerm?.status === "proposed";

      // Entity reassignment, source deprecation, the target approval
      // (when the survivor was still proposed), and the ledger row
      // commit in one batch so the ledger cannot fall out of step with
      // the mutation. The target entityCount recompute and the
      // changelog write stay sequential after the batch (denormalised
      // cache + display trail, matching the functions.$id merge). The
      // ledger is always epoch ms (Date.now()), not this route's
      // second-precision `now`.
      const batchStatements = [
        db
          .update(entities)
          .set({ primaryFunctionId: targetId, updatedAt: now })
          .where(
            and(
              authorityScope(entities, tenant.federationId, tenant.id),
              eq(entities.primaryFunctionId, sourceId)
            )
          ),
        db
          .update(vocabularyTerms)
          .set({
            status: "deprecated",
            mergedInto: targetId,
            entityCount: 0,
            reviewedBy: user.id,
            reviewedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(vocabularyTerms.id, sourceId),
              eq(vocabularyTerms.federationId, tenant.federationId)
            )
          ),
        logAuthorityOperation(db, {
          federationId: tenant.federationId,
          recordType: "vocabulary_term",
          operation: "merge",
          sourceId,
          targetId,
          userId: user.id,
          detail: reason ? { movedLinks, reason } : { movedLinks },
          now: Date.now(),
        }),
      ];
      if (targetNeedsApproval) {
        batchStatements.push(
          db
            .update(vocabularyTerms)
            .set({
              status: "approved",
              reviewedBy: user.id,
              reviewedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(vocabularyTerms.id, targetId),
                eq(vocabularyTerms.federationId, tenant.federationId),
              ),
            ),
        );
      }
      await db.batch(batchStatements as any);

      // Update target entity count (federation-scoped).
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .where(
          and(
            authorityScope(entities, tenant.federationId, tenant.id),
            eq(entities.primaryFunctionId, targetId)
          )
        )
        .all();
      await db
        .update(vocabularyTerms)
        .set({ entityCount: count, updatedAt: now })
        .where(
          and(
            eq(vocabularyTerms.id, targetId),
            eq(vocabularyTerms.federationId, tenant.federationId)
          )
        );

      // Changelog
      await db.insert(changelog).values({
        id: crypto.randomUUID(),
        recordId: sourceId,
        recordType: "vocabulary_term",
        userId: user.id,
        note: `Merged into ${targetId}`,
        diff: JSON.stringify({
          status: { old: "proposed", new: "deprecated" },
          mergedInto: { old: null, new: targetId },
        }),
        createdAt: now,
      });

      return { ok: true as const, action: "merged" };
    }

    default:
      return { ok: false as const, error: "unknown_intent" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReviewQueuePage({
  loaderData,
}: Route.ComponentProps) {
  const { terms, total, page, totalPages, vocabMatches } = loaderData;
  const { t } = useTranslation("vocabularies");
  // Vocabulary near-match cards read from the shared `decisions`
  // namespace — the plain table above keeps `vocabularies`.
  const { t: td } = useTranslation("decisions");
  const { formatNumber } = useFormatters();
  const [rejectingTermId, setRejectingTermId] = useState<string | null>(null);
  const approveFetcher = useFetcher();

  // One dialog open at a time, mirroring the proposals tab's idiom.
  const [vocabDialog, setVocabDialog] = useState<{
    kind: "keep" | "merge";
    match: VocabularyNearMatch;
  } | null>(null);
  const vocabFetcher = useFetcher<VocabActionResult>();
  const vocabPending = vocabFetcher.state !== "idle";

  useEffect(() => {
    if (vocabFetcher.state === "idle" && vocabFetcher.data?.ok) {
      setVocabDialog(null);
    }
  }, [vocabFetcher.state, vocabFetcher.data]);

  function vocabLoadLine(count: number) {
    return count > 0
      ? td("vocabLoad", { count, formattedCount: formatNumber(count) })
      : td("vocabLoadNone");
  }

  function submitKeep(match: VocabularyNearMatch, reason: string) {
    vocabFetcher.submit(
      { _action: "approve", termId: match.proposed.id, reason },
      { method: "post" },
    );
  }

  function submitMerge(
    match: VocabularyNearMatch,
    survivorCode: string,
    reason: string,
  ) {
    const survivorIsProposed = survivorCode === match.proposed.canonical;
    vocabFetcher.submit(
      {
        _action: "merge",
        sourceId: survivorIsProposed ? match.approved.id : match.proposed.id,
        targetId: survivorIsProposed ? match.proposed.id : match.approved.id,
        reason,
      },
      { method: "post" },
    );
  }

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toISOString().slice(0, 10);
  };

  return (
    <div>
      {/* Tab heading — the surface layout owns the page `h1`. */}
      <h2 className="mt-6 font-serif text-lg font-semibold text-stone-700">
        {t("review_queue")}
      </h2>
      <p className="mt-1 text-sm text-stone-500">
        {t("n_proposed", { count: total })}
      </p>

      {/* Vocabulary near-match cards — above the plain table, per the
          duplicates-vocabulary design round. */}
      {vocabMatches.length > 0 && (
        <div className="mt-6 flex flex-col gap-3">
          {vocabMatches.map((match) => (
            <VocabularyTermCard
              key={match.proposed.id}
              term={match.proposed.canonical}
              contextLine={td("vocabContext")}
              termProvenance={td("vocabIncomingProv")}
              existingTerm={match.approved.canonical}
              existingProvenance={td("vocabExistingProv")}
              suggestedAction={td("vocabSuggestedMerge", {
                term: match.approved.canonical,
              })}
              directionNote={td("vocabDirection", {
                term: match.approved.canonical,
              })}
              entityCounts={{
                incoming: match.proposed.entityCount,
                existing: match.approved.entityCount,
              }}
              pending={vocabPending}
              onKeep={() => setVocabDialog({ kind: "keep", match })}
              onMerge={() => setVocabDialog({ kind: "merge", match })}
            />
          ))}
        </div>
      )}

      {vocabFetcher.data?.ok === false && (
        <div className="mt-4">
          <SaveFeedbackBanner
            source={{ ok: false, error: td("errorGeneric") }}
            pending={vocabPending}
            labels={{ success: "", error: td("errorGeneric") }}
          />
        </div>
      )}

      {/* Empty state — only when there is truly nothing waiting: a
          page whose proposed terms are all carded above still has
          work in it. */}
      {terms.length === 0 && vocabMatches.length === 0 ? (
        <div className="mt-8 text-center">
          <p className="text-sm text-stone-400">{t("no_proposed")}</p>
        </div>
      ) : terms.length === 0 ? null : (
        <>
          {/* Terms table */}
          <div className="mt-6 rounded-lg border border-stone-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200">
                  <th className="px-4 py-3 text-left font-semibold text-stone-500">
                    {t("col_function")}
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-stone-500">
                    {t("proposed_by")}
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-stone-500">
                    {t("col_date")}
                  </th>
                  <th className="px-4 py-3 text-right font-semibold text-stone-500">
                    {t("col_usage")}
                  </th>
                  <th className="px-4 py-3 text-right font-semibold text-stone-500">
                    {t("col_actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {terms.map((term) => (
                  <tr
                    key={term.id}
                    className="border-b border-stone-200 last:border-b-0"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/vocabularies/functions/${term.id}`}
                        className="font-semibold text-indigo-deep hover:underline"
                      >
                        {term.canonical}
                      </Link>
                      {term.category && (
                        <span className="ml-2 text-xs text-stone-400">
                          {term.category}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-stone-500">
                      {term.proposedByName ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-stone-500">
                      {formatDate(term.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-stone-500">
                      {term.entityCount}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {/* Approve */}
                        <approveFetcher.Form method="post">
                          <input
                            type="hidden"
                            name="_action"
                            value="approve"
                          />
                          <input
                            type="hidden"
                            name="termId"
                            value={term.id}
                          />
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 rounded-md border border-verdigris-deep px-2 py-1 text-xs font-semibold text-verdigris-deep hover:bg-verdigris-tint"
                            title={t("approve_term")}
                          >
                            <Check className="h-3 w-3" />
                            {t("approve_term")}
                          </button>
                        </approveFetcher.Form>

                        {/* Reject */}
                        <button
                          type="button"
                          onClick={() =>
                            setRejectingTermId(
                              rejectingTermId === term.id ? null : term.id
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-md border border-madder-deep px-2 py-1 text-xs font-semibold text-madder-deep hover:bg-madder-tint"
                          title={t("reject_term")}
                        >
                          <X className="h-3 w-3" />
                          {t("reject_term")}
                        </button>
                      </div>

                      {/* Reject inline panel */}
                      {rejectingTermId === term.id && (
                        <div className="mt-2">
                          <RejectInlinePanel
                            termId={term.id}
                            termName={term.canonical}
                            isOpen={true}
                            onClose={() => setRejectingTermId(null)}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-stone-500">
                {t("common:pagination.page_of", {
                  current: page,
                  total: totalPages,
                })}
              </p>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link
                    to={`?page=${page - 1}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    {t("common:pagination.previous")}
                  </Link>
                )}
                {page < totalPages && (
                  <Link
                    to={`?page=${page + 1}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
                  >
                    {t("common:pagination.next")}
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Vocabulary card dialogs — one at a time. */}
      {vocabDialog?.kind === "keep" && (
        <DismissDialog
          tone="neutral"
          title={td("vocabKeepModalTitle", {
            term: vocabDialog.match.proposed.canonical,
          })}
          body={td("vocabKeepModalBody")}
          confirmLabel={td("keepOwnTerm")}
          reasonPlaceholder={td("whyOwnTerm")}
          pending={vocabPending}
          onCancel={() => setVocabDialog(null)}
          onConfirm={(reason) => submitKeep(vocabDialog.match, reason)}
        />
      )}
      {vocabDialog?.kind === "merge" && (
        <PairMergeDialog
          title={td("vocabMergeModalTitle")}
          body={td("vocabMergeModalBody")}
          options={[
            {
              code: vocabDialog.match.proposed.canonical,
              loadLine: vocabLoadLine(vocabDialog.match.proposed.entityCount),
            },
            {
              code: vocabDialog.match.approved.canonical,
              loadLine: vocabLoadLine(vocabDialog.match.approved.entityCount),
            },
          ]}
          defaultSurvivorCode={vocabDialog.match.approved.canonical}
          reasonPlaceholder={td("whySameSubject")}
          pending={vocabPending}
          onCancel={() => setVocabDialog(null)}
          onConfirm={(survivorCode, reason) =>
            submitMerge(vocabDialog.match, survivorCode, reason)
          }
        />
      )}
    </div>
  );
}
