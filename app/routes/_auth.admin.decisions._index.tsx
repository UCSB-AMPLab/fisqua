/**
 * Pending Decisions — Proposals tab
 *
 * The authority-proposal queue, and the default tab of the Pending
 * decisions surface. Producers (an import commit, a bulk load) file a
 * proposal when they meet a heading they cannot resolve against the
 * authority file on their own; this page is where an admin rules on
 * it. Three rulings, all handled by `ruleAuthorityProposal`:
 *
 *   Accept   take the proposal as filed. A mint proposal creates the
 *            entity or place under the maintaining agency's code
 *            prefix; a link proposal records the existing record it
 *            resolves to; a topic proposal creates nothing — the
 *            recorded ruling is the product.
 *   Amend    the same, with the type, name, or sort name corrected
 *            first. The amendment is written back into the payload so
 *            the trail shows what was actually accepted.
 *   Reject   no record is created; the reason is kept on the row.
 *
 * The page owns none of the permission logic. Visibility comes from
 * `listAuthorityProposals` (this tenant's questions plus the shared
 * ones); the three-way ownership gate on the ruling itself — tenant
 * admin for its own, federation steward for shared, 404 for another
 * tenant's — lives inside `ruleAuthorityProposal`. The route adds only
 * the admin guard and the `authorities` capability gate its sibling
 * authority surfaces carry.
 *
 * A single page-level fetcher drives every row. The rows are per
 * proposal and the accepted ones vanish on revalidation, so a result
 * rendered inside a row would disappear before it could be read — the
 * same reason the cataloguing team page hoists its fetcher. The
 * fetcher submission revalidates this loader on its own; there is no
 * explicit revalidate call.
 *
 * Pagination is the cheap kind: the loader asks for one row more than
 * it renders and uses the overflow as the "there is a next page"
 * signal, so the queue needs no second COUNT query.
 *
 * Evidence rides alongside the payload rather than inside it. The
 * reference codes a page names — the adjudication quote's and every
 * comment's — resolve to descriptions in one tenant-scoped IN query for
 * the whole page, so the card can link them; the heading's phrase-tier
 * mention count is one COUNT per row, which is what tells a reviewer
 * whether the name is load-bearing before they open anything.
 *
 * @version v0.7.0
 */

import { useEffect, useMemo, useState } from "react";
import {
  Link,
  useFetcher,
  useSearchParams,
  type FetcherWithComponents,
} from "react-router";
import { useTranslation } from "react-i18next";
import { Check, ChevronLeft, ChevronRight, ClipboardCheck } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { SaveFeedbackBanner } from "~/components/admin/save-feedback";
import {
  DecisionThread,
  type ThreadComment,
} from "~/components/admin/decision-comment";
import { DismissDialog } from "~/components/admin/dismiss-dialog";
import { AskPanel, SectionLabelRow } from "~/components/admin/decision-panels";
// Type-only: `pending-decisions.server` must never reach the client
// bundle, so the proposal-type list travels through the loader instead
// of being imported as a value here.
import type {
  AuthorityProposalPayload,
  ProposalType,
} from "~/lib/pending-decisions.server";
import type { Route } from "./+types/_auth.admin.decisions._index";

/** Proposals rendered per page. */
const PAGE_SIZE = 25;

type QueueStatus = "open" | "ruled";

interface ProposalRow {
  id: string;
  status: QueueStatus;
  ruling: string | null;
  rulingNote: string | null;
  resultId: string | null;
  ruledAt: number | null;
  createdAt: number;
  sourceModule: string;
  sourceRef: string | null;
  payload: AuthorityProposalPayload;
  comments: ThreadComment[];
}

/**
 * What the action hands back: a coded outcome, never prose. The copy
 * lives in the locale bundle, so the server module stays free of
 * user-facing English.
 */
type ProposalRulingResult =
  | { ok: true; ruling: "accepted" | "amended" | "rejected" }
  | { ok: false; code: "conflict" | "invalid" | "generic" };

/** Narrow the `?status=` param to the two the queue understands. */
function readStatus(value: string | null): QueueStatus {
  return value === "ruled" ? "ruled" : "open";
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const {
    listAuthorityProposals,
    listDecisionComments,
    countOpenAuthorityProposals,
    PROPOSAL_TYPES,
  } = await import("~/lib/pending-decisions.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);
  const url = new URL(request.url);
  const status = readStatus(url.searchParams.get("status"));
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

  // One row beyond the page: its presence is the next-page signal.
  // The open queue also carries a true total — the same number the
  // dashboard badge reads — because it is the figure that tells an
  // admin how much work is waiting. Ruled rows have no such helper and
  // their count line says "on this page" rather than inventing one.
  const [rows, openTotal] = await Promise.all([
    listAuthorityProposals(db, tenant, {
      status,
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countOpenAuthorityProposals(db, tenant),
  ]);
  const hasNext = rows.length > PAGE_SIZE;
  const threads = await listDecisionComments(
    db,
    rows.slice(0, PAGE_SIZE).map((r) => r.id),
  );

  const proposals: ProposalRow[] = rows.slice(0, PAGE_SIZE).map((row) => ({
    id: row.id,
    status: row.status as QueueStatus,
    ruling: row.ruling,
    rulingNote: row.rulingNote,
    resultId: row.resultId,
    ruledAt: row.ruledAt,
    createdAt: row.createdAt,
    sourceModule: row.sourceModule,
    sourceRef: row.sourceRef,
    payload: JSON.parse(row.payload) as AuthorityProposalPayload,
    comments: threads[row.id] ?? [],
  }));

  // Every reference code the page names, resolved in one statement.
  // A code is only a string until a description in THIS tenant answers
  // to it; codes that resolve to nothing (or to another tenant's
  // record) simply stay unlinked text.
  const { descriptions } = await import("~/db/schema");
  const { and, eq, inArray } = await import("drizzle-orm");
  const refCodes = new Set<string>();
  for (const proposal of proposals) {
    if (proposal.payload.evidenceRef) refCodes.add(proposal.payload.evidenceRef);
    for (const comment of proposal.comments) {
      if (comment.quoteRef) refCodes.add(comment.quoteRef);
    }
  }
  const refRows = refCodes.size
    ? await db
        .select({
          id: descriptions.id,
          referenceCode: descriptions.referenceCode,
        })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            inArray(descriptions.referenceCode, [...refCodes]),
          ),
        )
        .all()
    : [];
  const refIds: Record<string, string> = {};
  for (const row of refRows) refIds[row.referenceCode] = row.id;

  // How much of the catalogue already says this heading. Phrase tier
  // only: a loose token match would inflate the number into noise.
  const { countHeadingMentions } = await import("~/lib/global-search.server");
  const scope = {
    tenantId: tenant.id,
    federationId: tenant.federationId,
    // The capability gate above has already settled this.
    includeAuthorities: true,
  };
  const counted = await Promise.all(
    proposals.map(async (proposal) => [
      proposal.id,
      await countHeadingMentions(db, scope, proposal.payload.heading),
    ] as const),
  );
  const mentionCounts: Record<string, number> = Object.fromEntries(counted);

  return {
    proposals,
    status,
    page,
    hasNext,
    openTotal,
    refIds,
    mentionCounts,
    proposalTypes: [...PROPOSAL_TYPES] as ProposalType[],
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { ruleAuthorityProposal, PROPOSAL_TYPES: TYPES } = await import(
    "~/lib/pending-decisions.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);
  const formData = await request.formData();

  if ((formData.get("_action") as string) !== "rule") {
    return { ok: false as const, code: "generic" as const };
  }

  const id = (formData.get("id") as string) || "";
  const rulingRaw = formData.get("ruling");
  const ruling =
    rulingRaw === "accepted" ||
    rulingRaw === "amended" ||
    rulingRaw === "rejected"
      ? rulingRaw
      : null;
  if (!id || ruling === null) {
    return { ok: false as const, code: "generic" as const };
  }

  const rawType = (formData.get("amendedType") as string) || "";
  const amendedType = (TYPES as readonly string[]).includes(rawType)
    ? (rawType as ProposalType)
    : undefined;
  const amendedName = ((formData.get("amendedName") as string) || "").trim();
  const amendedSortName = (
    (formData.get("amendedSortName") as string) || ""
  ).trim();
  const note = ((formData.get("note") as string) || "").trim();

  try {
    await ruleAuthorityProposal(db, user, tenant, id, {
      ruling,
      // Amendments only travel on an `amended` ruling; an accept must
      // take the proposal exactly as filed.
      ...(ruling === "amended"
        ? {
            amendedType,
            amendedName: amendedName || undefined,
            amendedSortName: amendedSortName || undefined,
          }
        : {}),
      note: note || undefined,
    });
  } catch (err) {
    // 409 (already ruled by someone else) and 400 (a ruling the core
    // refused) belong on the page as inline feedback — they are things
    // the reviewer can see and act on. A 404 is the ownership gate
    // declining to confirm the row exists, so it stays a 404.
    if (err instanceof Response && (err.status === 409 || err.status === 400)) {
      return {
        ok: false as const,
        code: err.status === 409 ? ("conflict" as const) : ("invalid" as const),
      };
    }
    throw err;
  }

  return { ok: true as const, ruling };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DecisionProposalsPage({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("decisions");
  const {
    proposals,
    status,
    page,
    hasNext,
    openTotal,
    refIds,
    mentionCounts,
    proposalTypes,
  } = loaderData;
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher<ProposalRulingResult>();
  const [openPanel, setOpenPanel] = useState<{
    id: string;
    kind: "reject";
  } | null>(null);

  const pending = fetcher.state !== "idle";

  // Translate the action's coded result into the shape the shared
  // banner reads. The action returns codes, not prose, so the copy
  // stays in the locale bundle rather than in the server module.
  const feedbackSource = useMemo(() => {
    const data = fetcher.data;
    if (!data) return undefined;
    if (data.ok) {
      const key =
        data.ruling === "amended"
          ? "feedbackAmended"
          : data.ruling === "rejected"
            ? "feedbackRejected"
            : "feedbackAccepted";
      return { ok: true, message: t(key) };
    }
    const errorKey =
      data.code === "conflict"
        ? "errorConflict"
        : data.code === "invalid"
          ? "errorInvalid"
          : "errorGeneric";
    return { ok: false, error: t(errorKey) };
  }, [fetcher.data, t]);

  // The panel belongs to a row that may no longer be in the list after
  // a successful ruling; close it as soon as the submission lands.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setOpenPanel(null);
  }, [fetcher.state, fetcher.data]);

  const statusLink = (next: QueueStatus) => {
    const params = new URLSearchParams(searchParams);
    params.set("status", next);
    params.delete("page");
    return `?${params.toString()}`;
  };

  const pageLink = (next: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(next));
    return `?${params.toString()}`;
  };

  return (
    <div>
      {/* Status filter */}
      <nav className="mt-6 flex gap-2">
        {(["open", "ruled"] as const).map((value) => (
          <Link
            key={value}
            to={statusLink(value)}
            className={`rounded-full px-3 py-1 text-13 font-semibold transition-colors ${
              status === value
                ? "bg-indigo text-parchment"
                : "border border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
            }`}
          >
            {value === "open" ? t("filterOpen") : t("filterRuled")}
          </Link>
        ))}
      </nav>

      <div className="mt-4">
        <SaveFeedbackBanner
          source={feedbackSource}
          pending={pending}
          labels={{ success: t("feedbackAccepted"), error: t("errorGeneric") }}
        />
      </div>

      {proposals.length === 0 ? (
        <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-stone-200 px-6 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-md bg-verdigris-tint">
            <ClipboardCheck
              className="h-5 w-5 text-verdigris-deep"
              strokeWidth={1.5}
            />
          </span>
          <p className="font-serif text-xl text-indigo">
            {status === "open" ? t("emptyOpenHeading") : t("emptyRuledHeading")}
          </p>
          <p className="measure-36 text-13 text-stone-500">
            {status === "open" ? t("emptyOpenBody") : t("emptyRuledBody")}
          </p>
        </div>
      ) : (
        <>
          <p className="mt-5 text-13 nums text-stone-500">
            {status === "open"
              ? t("countOpen", { count: openTotal })
              : t("countRuled", { count: proposals.length })}
          </p>

          <div className="mt-3 flex flex-col gap-3">
            {proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                proposalTypes={proposalTypes}
                refIds={refIds}
                mentionCount={mentionCounts[proposal.id] ?? 0}
                panel={openPanel?.id === proposal.id ? openPanel.kind : null}
                onOpenPanel={(kind) =>
                  setOpenPanel(
                    openPanel?.id === proposal.id && openPanel.kind === kind
                      ? null
                      : { id: proposal.id, kind },
                  )
                }
                onClosePanel={() => setOpenPanel(null)}
                fetcher={fetcher}
                pending={pending}
                t={t}
              />
            ))}
          </div>

          {(page > 1 || hasNext) && (
            <div className="mt-5 flex items-center justify-between">
              <p className="text-13 nums text-stone-500">
                {t("pageOf", { page })}
              </p>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link
                    to={pageLink(page - 1)}
                    className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-1.5 text-13 text-stone-700 hover:bg-stone-50"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    {t("previous")}
                  </Link>
                )}
                {hasNext && (
                  <Link
                    to={pageLink(page + 1)}
                    className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-1.5 text-13 text-stone-700 hover:bg-stone-50"
                  >
                    {t("next")}
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proposal card
// ---------------------------------------------------------------------------

const TYPE_LABEL_KEYS: Record<ProposalType, string> = {
  person: "typePerson",
  family: "typeFamily",
  corporate: "typeCorporate",
  place: "typePlace",
  topic: "typeTopic",
};

const RULING_LABEL_KEYS: Record<string, string> = {
  accepted: "ruledAccepted",
  amended: "ruledAmended",
  rejected: "ruledRejected",
};

/** Role labels are the description editor's — one vocabulary, one set of names. */
const ROLE_NS = "descriptions_admin";

/** The link role a proposal falls back to when nobody proposed one. */
const DEFAULT_LINK_ROLE = "mentioned";

/** Mono reference chips read the same everywhere on this surface. */
const REF_CHIP_CLASS =
  "font-mono text-11 font-medium tracking-[0.02em] text-indigo-soft";

/**
 * A placeholder no heading can contain, used to find where the locked
 * sentence puts its reference so the code inside it can be a link. The
 * slot moves between languages, so the sentence is split around the
 * interpolation rather than assembled from fragments.
 */
const REF_SLOT = "\u0000";

function ProposalCard({
  proposal,
  proposalTypes,
  refIds,
  mentionCount,
  panel,
  onOpenPanel,
  onClosePanel,
  fetcher,
  pending,
  t,
}: {
  proposal: ProposalRow;
  /** The ruling vocabulary, handed down from the loader. */
  proposalTypes: ProposalType[];
  /** Reference code → description id, resolved for the whole page. */
  refIds: Record<string, string>;
  /** Descriptions whose text carries the heading as a phrase. */
  mentionCount: number;
  panel: "reject" | null;
  onOpenPanel: (kind: "reject") => void;
  onClosePanel: () => void;
  fetcher: FetcherWithComponents<ProposalRulingResult>;
  pending: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const { payload } = proposal;
  const isOpen = proposal.status === "open";

  // The recommended action, as a sentence: what saying yes will do.
  const actionKey =
    payload.action === "link"
      ? "recommendLink"
      : payload.proposedType === "topic"
        ? "recommendTopic"
        : "recommendCreate";
  const typeLabel = t(TYPE_LABEL_KEYS[payload.proposedType] ?? "typeTopic");
  const askValue = payload.uncertain
    ? t("recommendUndetermined")
    : t(actionKey, { type: typeLabel.toLowerCase() });

  // The grounds, in one line each. A topic links to nothing, so the
  // link line is a non-topic affair; the sentence is split around its
  // reference slot so the code inside it can carry the link.
  const evidenceRef = payload.evidenceRef;
  const linkLine =
    evidenceRef && payload.proposedType !== "topic"
      ? t("wouldLinkAs", {
          role: t(
            `${ROLE_NS}:role_${payload.proposedRole ?? DEFAULT_LINK_ROLE}`,
          ),
          ref: REF_SLOT,
        }).split(REF_SLOT)
      : null;
  const evidenceId = evidenceRef ? refIds[evidenceRef] : undefined;

  return (
    <div className="rounded-lg border border-stone-200 px-6 pb-4 pt-5 transition-shadow duration-150 hover:shadow-sm">
      {/* Object — carries size (Spectral); opens the detail page */}
      <Link
        to={proposal.id}
        className="font-serif text-2xl font-semibold leading-tight tracking-[-0.01em] text-indigo hover:underline"
      >
        {payload.proposedName}
      </Link>
      {payload.heading !== payload.proposedName && (
        <p className="mt-0.5 text-13 text-stone-500">
          {t("inTheIndexAs")}{" "}
          <span className="italic">“{payload.heading}”</span>
        </p>
      )}
      {payload.sortName && payload.sortName !== payload.proposedName && (
        <p className="mt-0.5 text-13 text-stone-500">
          {t("sortNameLabel")}: {payload.sortName}
        </p>
      )}

      {/* The ask — carries material (a tinted slot; outlined saffron
          when there is no recommendation to accept) */}
      <AskPanel value={askValue} judgement={payload.uncertain === true} />

      {/* The grounds under the recommendation: what accepting would
          link, or that nothing was read off a record, and how far the
          heading already reaches into the catalogue. Quiet lines, not
          panels — the ask above is the claim, these are its footing. */}
      {linkLine && (
        <p className="mt-2 text-13 text-stone-500">
          {linkLine[0]}
          {evidenceId ? (
            <Link
              to={`/admin/descriptions/${evidenceId}`}
              className={`${REF_CHIP_CLASS} hover:underline`}
            >
              {evidenceRef}
            </Link>
          ) : (
            <span className={REF_CHIP_CLASS}>{evidenceRef}</span>
          )}
          {linkLine[1] ?? ""}
        </p>
      )}
      {!evidenceRef && (
        <p className="mt-2 text-13 text-stone-500">
          {t("classifiedFromHeading")}
        </p>
      )}
      {mentionCount > 0 && (
        <p className="mt-1 text-13 nums text-stone-500">
          {t("mentionCount", { count: mentionCount })}
        </p>
      )}

      {/* The conversation */}
      {proposal.comments.length > 0 && (
        <>
          <SectionLabelRow label={t("commentsHeading")} />
          <div className="mt-3">
            <DecisionThread comments={proposal.comments} quoteRefIds={refIds} />
          </div>
        </>
      )}

      {/* Ruled rows carry their outcome instead of controls */}
      {!isOpen && (
        <div className="mt-4 border-t border-stone-200 pt-3 text-13 text-stone-500">
          <span className="font-semibold text-stone-700">
            {t(RULING_LABEL_KEYS[proposal.ruling ?? ""] ?? "ruledAccepted")}
          </span>
          {proposal.ruledAt
            ? ` · ${t("ruledOn", {
                date: new Date(proposal.ruledAt).toISOString().slice(0, 10),
              })}`
            : ""}
          {proposal.resultId ? ` · ${t("ruledResult")}` : ""}
          {proposal.rulingNote ? ` — ${proposal.rulingNote}` : ""}
        </div>
      )}

      {/* Options. "Review and decide" is not a third verb — it is a
          door to another route, so it sits on the left as a text
          button; the primary is whatever the system is confident
          about. Dismiss is deliberately not madder: destructiveness
          escalates at the confirmation, not from the list. Judgement
          rows have no recommendation to accept, so the door is
          promoted to primary and Dismiss demotes to a ghost — you
          should not dismiss what you have not read. */}
      {isOpen && (
        <div className="mt-4 flex items-center gap-2 border-t border-stone-200 pt-3">
          {payload.uncertain ? (
            <>
              <Link
                to={proposal.id}
                className="mr-auto inline-flex h-[42px] items-center gap-1.5 rounded-lg bg-indigo px-4 text-15 font-semibold text-white hover:bg-indigo-deep"
              >
                {t("reviewAndDecide")}
                <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
              </Link>
              <button
                type="button"
                onClick={() => onOpenPanel("reject")}
                className="inline-flex h-[42px] items-center rounded-lg px-2.5 text-15 font-semibold text-indigo-soft hover:bg-stone-100 hover:text-indigo"
              >
                {t("optDismiss")}
              </button>
            </>
          ) : (
            <>
              <Link
                to={proposal.id}
                className="mr-auto inline-flex h-[42px] items-center gap-1.5 rounded-lg px-1.5 text-15 font-semibold text-indigo hover:underline"
              >
                {t("reviewAndDecide")}
                <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
              </Link>
              <button
                type="button"
                onClick={() => onOpenPanel("reject")}
                className="inline-flex h-[42px] items-center rounded-lg border border-stone-300 bg-white px-4 text-15 font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50"
              >
                {t("optDismiss")}
              </button>
              <fetcher.Form method="post">
                <input type="hidden" name="_action" value="rule" />
                <input type="hidden" name="id" value={proposal.id} />
                <input type="hidden" name="ruling" value="accepted" />
                <button
                  type="submit"
                  disabled={pending}
                  className="inline-flex h-[42px] items-center gap-1.5 rounded-lg bg-verdigris pl-3.5 pr-4 text-15 font-semibold text-white hover:bg-verdigris-deep disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Check className="h-4 w-4" strokeWidth={1.75} />
                  {t("optAcceptRecommendation")}
                </button>
              </fetcher.Form>
            </>
          )}
        </div>
      )}

      {/* Dismissal always confirms — the only madder in the flow */}
      {isOpen && panel === "reject" && (
        <DismissDialog
          objectName={payload.proposedName}
          pending={pending}
          onCancel={onClosePanel}
          onConfirm={(reason) =>
            fetcher.submit(
              {
                _action: "rule",
                id: proposal.id,
                ruling: "rejected",
                note: reason,
              },
              { method: "post" },
            )
          }
        />
      )}
    </div>
  );
}
