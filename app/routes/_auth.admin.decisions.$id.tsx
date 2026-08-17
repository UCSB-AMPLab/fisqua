/**
 * Pending Decisions — proposal detail
 *
 * The considered lane. The queue's cards answer clear-cut questions in
 * place; this page opens one proposal full-screen for the rest, and it
 * is deliberately NOT a bigger card: the left column is the record as
 * it would be created — the mint-time fields, pre-filled from the
 * proposal and editable in place — and the right column is the case
 * for it (reasoning, quoted evidence, provenance, the judgement
 * callout when the producer could not settle it). The reviewer reads
 * right, edits left, and the primary action mints exactly what the
 * form says at that moment, so "amend" stops being a separate concept
 * here: an edited form and an untouched form go through the same
 * button.
 *
 * The boundary is the mint: this form owns what a mint writes (type,
 * names, variants, place type, internal notes). Everything else a
 * record can carry — coordinates, external identifiers, dates,
 * history — belongs to the record editor, which is one click away the
 * moment the record exists; the success state links straight to it.
 *
 * Permissions are the queue's: visibility via the scoped read
 * (`getAuthorityProposal` — foreign and missing are both this route's
 * 404), the ruling gate inside `ruleAuthorityProposal`. The route adds
 * the admin guard and the `authorities` capability gate its siblings
 * carry.
 *
 * The conversation is writable here, not just readable: the thread is
 * handed the signed-in reader, and the two acts it can raise — rewrite
 * a comment, retract one — post back as their own intents. They are
 * not rulings and they do not read as such: the gate is the comment
 * module's (author-only edit, author-or-admin delete), the result rides
 * the thread's fetcher rather than the page's `actionData`, and a
 * successful delete simply stops appearing in the next load.
 *
 * The right column also carries the evidence the producer could not
 * fit in a comment: the descriptions whose text says the heading (the
 * phrase tier, falling back to related terms only when the phrase
 * turns up nothing), and the external authorities a reconciliation
 * pass proposed. Neither is a ruling and neither is recorded on its
 * own — a candidate becomes a registry row only when the reviewer
 * picks it and accepts, which is why its radios post through the
 * ruling form rather than a form of their own.
 *
 * @version v0.7.0
 */

import { useState } from "react";
import { Link, useNavigation, useSubmit } from "react-router";
import { useTranslation } from "react-i18next";
import { Check, ChevronLeft, ExternalLink } from "lucide-react";
import { tenantContext, userContext } from "../context";
import {
  DecisionThread,
  type ThreadComment,
} from "~/components/admin/decision-comment";
import { DismissDialog } from "~/components/admin/dismiss-dialog";
import { AskPanel, SectionLabelRow } from "~/components/admin/decision-panels";
import { requireCapability } from "../lib/tenant";
import type {
  AuthorityProposalPayload,
  ProposalType,
} from "~/lib/pending-decisions.server";
import type { Route } from "./+types/_auth.admin.decisions.$id";

/** Evidence rows the panel shows before deferring to search. */
const EVIDENCE_ROWS = 10;

/** Role labels are the description editor's — one vocabulary, one set of names. */
const ROLE_NS = "descriptions_admin";

/** The link role a proposal falls back to when nobody proposed one. */
const DEFAULT_LINK_ROLE = "mentioned";

/**
 * Where each reconciliation scheme's identifiers live. A candidate is
 * only worth showing if the reviewer can go and read it.
 */
const EXTERNAL_URLS: Record<string, (id: string) => string> = {
  lcnaf: (id) => `https://id.loc.gov/authorities/names/${encodeURIComponent(id)}`,
  lcsh: (id) =>
    `https://id.loc.gov/authorities/subjects/${encodeURIComponent(id)}`,
  geonames: (id) => `https://www.geonames.org/${encodeURIComponent(id)}`,
};

/**
 * The ruling form's DOM id. The external-match radios sit in the right
 * column, a column away from the form they belong to, so they claim it
 * by name rather than by nesting.
 */
const RULING_FORM_ID = "proposal-ruling";

type DetailRulingResult =
  | {
      ok: true;
      ruling: "accepted" | "amended" | "rejected";
      resultId: string | null;
      resultPath: string | null;
      resultCode: string | null;
      /** Reference code of the description the accept linked, if any. */
      linkedRef: string | null;
      /** The role that link was written under; null when nothing linked. */
      linkedRole: string | null;
    }
  | { ok: false; code: "conflict" | "invalid" | "generic" | "commented" };

/**
 * Editing or deleting one comment settles nothing about the proposal,
 * so its result travels back through the thread's own fetcher and never
 * touches the ruling surface. Keeping it a separate shape is what lets
 * the page tell the two apart.
 */
type DetailCommentResult =
  | { ok: true; code: "commentEdited" | "commentDeleted" }
  | { ok: false; code: "commentError" };

type DetailActionResult = DetailRulingResult | DetailCommentResult;

function isCommentResult(
  result: DetailActionResult,
): result is DetailCommentResult {
  return (
    "code" in result &&
    (result.code === "commentEdited" ||
      result.code === "commentDeleted" ||
      result.code === "commentError")
  );
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context, params }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const {
    getAuthorityProposal,
    listDecisionComments,
    PROPOSAL_TYPES,
  } = await import("~/lib/pending-decisions.server");
  const { ENTITY_ROLES, PLACE_ROLES, PLACE_TYPES } = await import(
    "~/lib/validation/enums"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);
  const row = await getAuthorityProposal(db, tenant, params.id);
  if (!row) {
    throw new Response("Not found", { status: 404 });
  }

  const payload = JSON.parse(row.payload) as AuthorityProposalPayload;
  const threads = await listDecisionComments(db, [row.id]);
  const comments = (threads[row.id] ?? []) as ThreadComment[];

  // Every reference code this page names — the adjudication quote's and
  // the thread's — in one tenant-scoped statement. A code that names no
  // description of ours resolves to nothing and stays plain text.
  const { descriptions } = await import("~/db/schema");
  const { and, eq, inArray } = await import("drizzle-orm");
  const refCodes = new Set<string>();
  if (payload.evidenceRef) refCodes.add(payload.evidenceRef);
  for (const comment of comments) {
    if (comment.quoteRef) refCodes.add(comment.quoteRef);
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
  for (const refRow of refRows) refIds[refRow.referenceCode] = refRow.id;

  // The catalogue's own answer to the heading. The phrase tier is the
  // evidence proper; the related tier is a consolation the search
  // module computes only when the phrase turns up nothing at all.
  const { selectHeadingMentions, countHeadingMentions } = await import(
    "~/lib/global-search.server"
  );
  const scope = {
    tenantId: tenant.id,
    federationId: tenant.federationId,
    // The capability gate above has already settled this.
    includeAuthorities: true,
  };
  const [mentions, mentionCount] = await Promise.all([
    selectHeadingMentions(db, scope, payload.heading, EVIDENCE_ROWS),
    countHeadingMentions(db, scope, payload.heading),
  ]);

  return {
    comments,
    viewer: { userId: user.id, isAdmin: user.isAdmin },
    refIds,
    evidence: {
      phrase: mentions.phrase,
      related: mentions.related,
      count: mentionCount,
    },
    entityRoles: [...ENTITY_ROLES],
    placeRoles: [...PLACE_ROLES],
    proposal: {
      id: row.id,
      status: row.status,
      ruling: row.ruling,
      rulingNote: row.rulingNote,
      resultId: row.resultId,
      ruledAt: row.ruledAt,
      sourceModule: row.sourceModule,
      sourceRef: row.sourceRef,
      payload,
    },
    proposalTypes: [...PROPOSAL_TYPES],
    placeTypes: [...PLACE_TYPES],
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({
  request,
  context,
  params,
}: Route.ActionArgs): Promise<DetailActionResult> {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { ruleAuthorityProposal, PROPOSAL_TYPES } = await import(
    "~/lib/pending-decisions.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");
  const db = drizzle(context.cloudflare.env.DB);

  const formData = await request.formData();
  const intent = formData.get("_action");

  // A comment is not a ruling: it appends to the conversation and the
  // question stays open. Author is the signed-in user.
  if (intent === "comment") {
    const { addDecisionComment, getAuthorityProposal: getP } = await import(
      "~/lib/pending-decisions.server"
    );
    const target = await getP(db, tenant, params.id);
    if (!target) throw new Response("Not found", { status: 404 });
    const body = ((formData.get("body") as string) || "").trim();
    if (!body) return { ok: false as const, code: "invalid" as const };
    await addDecisionComment(
      db,
      params.id,
      { userId: user.id, role: "admin" },
      body,
    );
    return { ok: false as const, code: "commented" as const };
  }

  // Rewriting or retracting a comment already on the thread. The gate
  // is the server core's — author-only on edit, author-or-admin on
  // delete — and every refusal it throws reads the same here: the
  // thread only needs to know the act did not land.
  if (intent === "editComment" || intent === "deleteComment") {
    const { deleteDecisionComment, editDecisionComment } = await import(
      "~/lib/decision-comments.server"
    );
    const commentId = ((formData.get("commentId") as string) || "").trim();
    if (!commentId) {
      return { ok: false as const, code: "commentError" as const };
    }
    try {
      if (intent === "editComment") {
        await editDecisionComment(
          db,
          user,
          tenant,
          commentId,
          (formData.get("body") as string) || "",
        );
        return { ok: true as const, code: "commentEdited" as const };
      }
      await deleteDecisionComment(db, user, tenant, commentId);
      return { ok: true as const, code: "commentDeleted" as const };
    } catch (err) {
      if (err instanceof Response) {
        return { ok: false as const, code: "commentError" as const };
      }
      throw err;
    }
  }

  const rejected = intent === "reject";

  const rawType = (formData.get("type") as string) || "";
  const amendedType = (PROPOSAL_TYPES as readonly string[]).includes(rawType)
    ? (rawType as ProposalType)
    : undefined;
  const variants = ((formData.get("nameVariants") as string) || "")
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);

  // The trail distinguishes accepted from amended by whether the form
  // still matches the filed proposal — not by which button was pressed.
  const { getAuthorityProposal } = await import(
    "~/lib/pending-decisions.server"
  );
  const filedRow = await getAuthorityProposal(db, tenant, params.id);
  const filed = filedRow
    ? (JSON.parse(filedRow.payload) as AuthorityProposalPayload)
    : null;
  const name = ((formData.get("displayName") as string) || "").trim();
  const sortName = ((formData.get("sortName") as string) || "").trim();
  const untouched =
    filed !== null &&
    amendedType === filed.proposedType &&
    name === filed.proposedName &&
    (sortName === "" || sortName === (filed.sortName ?? "")) &&
    variants.length === 0 &&
    !((formData.get("placeType") as string) || "").trim() &&
    !((formData.get("internalNote") as string) || "").trim();

  // The evidence controls. None of these is an amendment — they say
  // what the accept should do about the record the proposal was read
  // off, and about the external match the pipeline offered — so they
  // stay out of the untouched diff above. The confirmed candidate
  // travels as "scheme:id" and is checked against the payload's own
  // list server-side; the form is never trusted to name an authority.
  const linkRole = ((formData.get("linkRole") as string) || "").trim();
  const skipLink = formData.get("skipLink") !== null;
  const confirmedRaw = ((formData.get("confirmedExternal") as string) || "").trim();
  const schemeEnd = confirmedRaw.indexOf(":");
  const confirmedExternal =
    confirmedRaw && confirmedRaw !== "none" && schemeEnd > 0
      ? {
          scheme: confirmedRaw.slice(0, schemeEnd),
          externalId: confirmedRaw.slice(schemeEnd + 1),
        }
      : undefined;

  try {
    const result = await ruleAuthorityProposal(db, user, tenant, params.id, {
      ruling: rejected ? "rejected" : untouched ? "accepted" : "amended",
      ...(rejected
        ? {}
        : {
            amendedType,
            amendedName: ((formData.get("displayName") as string) || "").trim(),
            amendedSortName: (
              (formData.get("sortName") as string) || ""
            ).trim(),
            amendedNameVariants: variants,
            amendedPlaceType:
              ((formData.get("placeType") as string) || "").trim() || undefined,
            amendedInternalNote:
              ((formData.get("internalNote") as string) || "").trim() ||
              undefined,
            linkRole: linkRole || undefined,
            skipLink,
            confirmedExternal,
          }),
      note: ((formData.get("note") as string) || "").trim() || undefined,
    });

    let resultPath: string | null = null;
    let resultCode: string | null = null;
    if (result.resultId && !rejected) {
      const { entities, places } = await import("~/db/schema");
      const { eq } = await import("drizzle-orm");
      const table = amendedType === "place" ? places : entities;
      const codeCol =
        amendedType === "place" ? places.placeCode : entities.entityCode;
      const rec = await db
        .select({ code: codeCol })
        .from(table)
        .where(eq(table.id, result.resultId))
        .get();
      resultPath =
        amendedType === "place"
          ? `/admin/places/${result.resultId}`
          : `/admin/entities/${result.resultId}`;
      resultCode = rec?.code ?? null;
    }
    return {
      ok: true,
      ruling: result.ruling,
      resultId: result.resultId,
      resultPath,
      resultCode,
      linkedRef: result.linkedRef,
      // The core resolves the role the same way; reporting it here
      // keeps the success line saying what was actually written.
      linkedRole: result.linkedRef
        ? linkRole || filed?.proposedRole || DEFAULT_LINK_ROLE
        : null,
    };
  } catch (err) {
    if (err instanceof Response && (err.status === 409 || err.status === 400)) {
      return {
        ok: false,
        code: err.status === 409 ? "conflict" : "invalid",
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const TYPE_LABEL_KEYS: Record<string, string> = {
  person: "typePerson",
  family: "typeFamily",
  corporate: "typeCorporate",
  place: "typePlace",
  topic: "typeTopic",
};

export default function DecisionDetailPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { t } = useTranslation("decisions");
  const {
    proposal,
    proposalTypes,
    placeTypes,
    comments,
    viewer,
    refIds,
    evidence,
    entityRoles,
    placeRoles,
  } = loaderData;
  const { payload } = proposal;
  const navigation = useNavigation();
  const submit = useSubmit();
  const pending = navigation.state !== "idle";
  const [type, setType] = useState<string>(payload.proposedType);
  const [dismissing, setDismissing] = useState(false);

  // Comment acts come back through the thread's fetcher, so they never
  // reach `actionData` — but the action's type covers both, and the
  // ruling surface must read only rulings.
  const rulingData =
    actionData && !isCommentResult(actionData) ? actionData : undefined;

  const ruled = proposal.status !== "open" || rulingData?.ok === true;

  const inputClass =
    "mt-1.5 block h-12 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm text-stone-700 focus:border-verdigris focus:outline-none focus:ring-1 focus:ring-verdigris";
  const textareaClass =
    "mt-1.5 block w-full resize-none rounded-lg border border-stone-300 bg-white p-3 text-sm leading-normal text-stone-700 placeholder:text-stone-400 focus:border-verdigris focus:outline-none focus:ring-1 focus:ring-verdigris";
  const labelClass = "block text-sm font-medium text-stone-700";

  const askValue = payload.uncertain
    ? t("recommendUndetermined")
    : payload.action === "link"
      ? t("recommendLink")
      : payload.proposedType === "topic"
        ? t("recommendTopic")
        : t("recommendCreate", {
            type: t(TYPE_LABEL_KEYS[payload.proposedType]).toLowerCase(),
          });

  // A link needs somewhere to land: the reference the proposal cites,
  // resolved against this tenant's descriptions. An unresolved code
  // offers nothing to link, so the row stays away rather than
  // promising a link the accept will not make.
  const evidenceId = payload.evidenceRef
    ? refIds[payload.evidenceRef]
    : undefined;
  const linkable = type !== "topic" && evidenceId !== undefined;
  const roleOptions = type === "place" ? placeRoles : entityRoles;
  const proposedRole = payload.proposedRole ?? DEFAULT_LINK_ROLE;
  // Switching the type switches the vocabulary; a role from the other
  // enum cannot survive the swap, and "mentioned" is in both.
  const defaultRole = (roleOptions as readonly string[]).includes(proposedRole)
    ? proposedRole
    : DEFAULT_LINK_ROLE;

  // The catalogue's own evidence. Phrase tier when it found anything,
  // the related terms only as its fallback — never both.
  const evidenceRows =
    evidence.phrase.length > 0 ? evidence.phrase : evidence.related;
  const evidenceIsPhrase = evidence.phrase.length > 0;
  const searchHref = `/search?q=${encodeURIComponent(`"${payload.heading}"`)}`;

  const externalCandidates = payload.externalCandidates ?? [];

  return (
    <div>
      <Link
        to="/admin/decisions"
        className="mt-6 inline-flex items-center gap-1 text-13 font-medium text-stone-500 hover:text-indigo"
      >
        <ChevronLeft className="h-[15px] w-[15px]" strokeWidth={1.75} />
        {t("backToQueue")}
      </Link>

      {/* Success state replaces the working surface entirely */}
      {rulingData?.ok === true ? (
        <div className="mt-6 rounded-xl border border-verdigris bg-verdigris-tint px-6 py-8">
          <p className="font-serif text-xl text-indigo">
            {rulingData.ruling === "rejected"
              ? t("detailRejectedHeading")
              : payload.proposedType === "topic" && !rulingData.resultId
                ? t("detailTopicHeading")
                : t("detailCreatedHeading")}
          </p>
          {rulingData.resultCode && (
            <p className="mt-1 font-mono text-13 text-stone-600">
              {rulingData.resultCode}
            </p>
          )}
          {rulingData.linkedRef && (
            <p className="mt-1 text-13 text-stone-600">
              {t("linkCreated", {
                ref: rulingData.linkedRef,
                role: t(
                  `${ROLE_NS}:role_${rulingData.linkedRole ?? DEFAULT_LINK_ROLE}`,
                ),
              })}
            </p>
          )}
          <div className="mt-4 flex items-center gap-3">
            {rulingData.resultPath && (
              <Link
                to={rulingData.resultPath}
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo px-3 py-1.5 text-13 font-semibold text-parchment hover:bg-indigo-deep"
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t("viewRecord")}
              </Link>
            )}
            <Link
              to="/admin/decisions"
              className="text-13 text-stone-600 hover:text-stone-800"
            >
              {t("backToQueue")}
            </Link>
          </div>
        </div>
      ) : ruled ? (
        /* Landed on an already-ruled question via a stale link */
        <div className="mt-6 rounded-xl border border-stone-200 px-6 py-8">
          <p className="font-serif text-xl text-indigo">{payload.proposedName}</p>
          <p className="mt-2 text-13 text-stone-500">
            {t("detailAlreadyRuled")}
            {proposal.rulingNote ? ` — ${proposal.rulingNote}` : ""}
          </p>
        </div>
      ) : (
        <div className="mt-5 grid items-start gap-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
          {/* Left — the ruling: the record as it would be created,
              pre-filled and editable. An edited form and an untouched
              form go through the same button; the action diffs them. */}
          <form id={RULING_FORM_ID} method="post" className="flex flex-col">
            <p className="font-serif text-2xl font-semibold leading-tight tracking-[-0.01em] text-indigo">
              {payload.proposedName}
            </p>
            {payload.heading !== payload.proposedName && (
              <p className="mt-0.5 text-13 text-stone-500">
                {t("inTheIndexAs")}{" "}
                <span className="italic">“{payload.heading}”</span>
              </p>
            )}

            <SectionLabelRow label={t("recordToCreate")} />

            <div className="mt-4 flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className={labelClass}>
                  {t("amendTypeLabel")}
                  <select
                    name="type"
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className={inputClass}
                  >
                    {proposalTypes.map((value) => (
                      <option key={value} value={value}>
                        {t(TYPE_LABEL_KEYS[value])}
                      </option>
                    ))}
                  </select>
                </label>

                {/* Record type and place type are one decision, so
                    they share a row; other types pair the sort name */}
                {type === "place" && (
                  <label className={labelClass}>
                    {t("detailPlaceType")}
                    <select name="placeType" defaultValue="" className={inputClass}>
                      <option value="">{t("detailPlaceTypeNone")}</option>
                      {placeTypes.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {type !== "topic" && type !== "place" && (
                  <label className={labelClass}>
                    {t("amendSortNameLabel")}
                    <input
                      type="text"
                      name="sortName"
                      defaultValue={payload.sortName ?? ""}
                      placeholder={t("amendSortNamePlaceholder")}
                      className={inputClass}
                    />
                  </label>
                )}
              </div>

              <label className={labelClass}>
                {t("amendNameLabel")}
                <input
                  type="text"
                  name="displayName"
                  defaultValue={payload.proposedName}
                  className={inputClass}
                />
              </label>

              {type !== "topic" && (
                <>
                  <label className={labelClass}>
                    {t("detailVariants")}
                    <textarea
                      name="nameVariants"
                      rows={3}
                      placeholder={t("detailVariantsPlaceholder")}
                      className={textareaClass}
                    />
                  </label>

                  <label className={labelClass}>
                    {t("detailInternalNote")}
                    <textarea
                      name="internalNote"
                      rows={2}
                      placeholder={t("detailInternalNotePlaceholder")}
                      className={textareaClass}
                    />
                  </label>
                </>
              )}

              {/* What the accept does about the record the proposal was
                  read off. The vocabulary follows the type select above
                  — a place role cannot describe an entity link — so the
                  two selects swap the way place type and sort name do,
                  each carrying its own default. */}
              {linkable && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className={labelClass}>
                    {t("linkRoleLabel")}
                    {type === "place" ? (
                      <select
                        key="place"
                        name="linkRole"
                        defaultValue={defaultRole}
                        className={inputClass}
                      >
                        {placeRoles.map((role) => (
                          <option key={role} value={role}>
                            {t(`${ROLE_NS}:role_${role}`)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <select
                        key="entity"
                        name="linkRole"
                        defaultValue={defaultRole}
                        className={inputClass}
                      >
                        {entityRoles.map((role) => (
                          <option key={role} value={role}>
                            {t(`${ROLE_NS}:role_${role}`)}
                          </option>
                        ))}
                      </select>
                    )}
                  </label>
                  <label className="flex items-center gap-2 self-end pb-3.5 text-sm font-medium text-stone-700">
                    <input
                      type="checkbox"
                      name="skipLink"
                      className="h-4 w-4 rounded border-stone-300 text-verdigris focus:ring-verdigris"
                    />
                    {t("skipLinkLabel")}
                  </label>
                </div>
              )}
            </div>

            {type !== "topic" && (
              <p className="mt-3 max-w-[44ch] text-xs leading-normal text-stone-500 [text-wrap:pretty]">
                {t("detailEditorHint")}
              </p>
            )}

            {/* Pinned so repeated rulings never chase the button below
                the fold */}
            <div className="sticky bottom-0 mt-5 flex items-center gap-2 border-t border-stone-200 bg-white pb-2 pt-4">
              <button
                type="submit"
                name="_action"
                value="create"
                disabled={pending}
                className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-verdigris pl-4 pr-4.5 text-15 font-semibold text-white hover:bg-verdigris-deep disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Check className="h-4 w-4" strokeWidth={1.75} />
                {type === "topic" ? t("optConfirmTopic") : t("optCreate")}
              </button>
              <button
                type="button"
                onClick={() => setDismissing(true)}
                className="inline-flex h-11 items-center rounded-lg border border-stone-300 bg-white px-4.5 text-15 font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50"
              >
                {type === "topic" ? t("optNoRecord") : t("optNoCreate")}
              </button>
            </div>

            {rulingData?.ok === false && rulingData.code !== "commented" && (
              <p className="mt-3 text-13 text-madder-deep">
                {t(
                  rulingData.code === "conflict"
                    ? "errorConflict"
                    : rulingData.code === "invalid"
                      ? "errorInvalid"
                      : "errorGeneric",
                )}
              </p>
            )}
          </form>

          {/* Right — the case: the system's recommendation and the
              conversation. The subtle surface is what separates the
              argument from the work; the ask panel here is what was
              recommended, the form is what you are about to make. */}
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-5">
              <AskPanel
                value={askValue}
                judgement={payload.uncertain === true}
                className=""
              />

              {/* What the catalogue already says. The rows read like the
                  linked-descriptions rows they stand in for — title,
                  then the reference code in mono — and the panel stops
                  at ten, handing the rest to search rather than
                  becoming a second results page. */}
              {evidenceRows.length > 0 && (
                <>
                  <SectionLabelRow
                    label={
                      evidenceIsPhrase
                        ? t("evidenceHeading")
                        : t("evidenceRelatedHeading")
                    }
                  />
                  <div className="mt-3 flex flex-col gap-2">
                    {evidenceRows.map((mention) => (
                      <div
                        key={mention.id}
                        className="flex items-baseline gap-3 overflow-hidden"
                      >
                        <Link
                          to={`/admin/descriptions/${mention.id}`}
                          className="truncate font-serif text-sm text-stone-700 hover:text-indigo-deep hover:underline"
                        >
                          {mention.title}
                        </Link>
                        {mention.referenceCode && (
                          <span className="whitespace-nowrap font-mono text-xs text-stone-500">
                            {mention.referenceCode}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  {evidenceIsPhrase && evidence.count > EVIDENCE_ROWS && (
                    <Link
                      to={searchHref}
                      className="mt-2 inline-block text-13 font-medium text-indigo hover:underline"
                    >
                      {t("evidenceSeeAll")}
                    </Link>
                  )}
                </>
              )}

              {/* Reconciliation candidates, as the pipeline stamped
                  them. Recording one is the reviewer's act and rides
                  the ruling form a column away, which is what the
                  `form` attribute on each radio is for; a topic has no
                  record to hang an identifier on, so it gets the
                  reading and none of the controls. */}
              {externalCandidates.length > 0 && (
                <>
                  <SectionLabelRow label={t("externalHeading")} />
                  <div className="mt-3 flex flex-col gap-2">
                    {externalCandidates.map((candidate) => {
                      const value = `${candidate.scheme}:${candidate.id}`;
                      const href = EXTERNAL_URLS[candidate.scheme]?.(
                        candidate.id,
                      );
                      return (
                        <div
                          key={value}
                          className="flex items-baseline gap-2 overflow-hidden"
                        >
                          {type !== "topic" && (
                            <input
                              type="radio"
                              id={`external-${value}`}
                              name="confirmedExternal"
                              value={value}
                              form={RULING_FORM_ID}
                              className="h-4 w-4 border-stone-300 text-verdigris focus:ring-verdigris"
                            />
                          )}
                          <label
                            htmlFor={`external-${value}`}
                            className="truncate text-sm text-stone-700"
                          >
                            {candidate.label}
                          </label>
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener"
                              className="whitespace-nowrap font-mono text-11 text-indigo-soft hover:underline"
                            >
                              {candidate.scheme} {candidate.id}
                            </a>
                          ) : (
                            <span className="whitespace-nowrap font-mono text-11 text-stone-500">
                              {candidate.scheme} {candidate.id}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {type !== "topic" && (
                      <div className="flex items-baseline gap-2">
                        <input
                          type="radio"
                          id="external-none"
                          name="confirmedExternal"
                          value="none"
                          defaultChecked
                          form={RULING_FORM_ID}
                          className="h-4 w-4 border-stone-300 text-verdigris focus:ring-verdigris"
                        />
                        <label
                          htmlFor="external-none"
                          className="text-sm text-stone-700"
                        >
                          {t("externalNone")}
                        </label>
                      </div>
                    )}
                  </div>
                  {type !== "topic" && (
                    <p className="mt-2 text-xs leading-normal text-stone-500">
                      {t("externalConfirmHint")}
                    </p>
                  )}
                </>
              )}

              <SectionLabelRow label={t("commentsHeading")} />

              {comments.length > 0 && (
                <div className="mt-3">
                  <DecisionThread
                    comments={comments}
                    viewer={viewer}
                    quoteRefIds={refIds}
                  />
                </div>
              )}

              {/* Anyone entitled to see the question may add to its
                  conversation; ruling stays a separate act. */}
              <form method="post" className="mt-4 border-t border-stone-200 pt-4">
                <label className={labelClass} htmlFor="decision-comment-body">
                  {t("addComment")}
                </label>
                <textarea
                  id="decision-comment-body"
                  name="body"
                  rows={2}
                  placeholder={t("addCommentPlaceholder")}
                  className={textareaClass}
                />
                <button
                  type="submit"
                  name="_action"
                  value="comment"
                  disabled={pending}
                  className="mt-2.5 inline-flex h-[42px] items-center rounded-lg border border-stone-300 bg-white px-3.5 text-sm font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {t("postComment")}
                </button>
              </form>
            </div>
          </aside>
        </div>
      )}

      {/* "Don't create" is the same outcome as Dismiss — it routes
          through the same dialog, and madder waits for the confirm */}
      {dismissing && !ruled && (
        <DismissDialog
          objectName={payload.proposedName}
          pending={pending}
          onCancel={() => setDismissing(false)}
          onConfirm={(reason) =>
            submit({ _action: "reject", note: reason }, { method: "post" })
          }
        />
      )}
    </div>
  );
}
