/**
 * Pending Decisions — duplicate pair collation ("Look closer")
 *
 * The considered lane for a duplicate pair, opened from the door on the
 * pair card. It is deliberately NOT a bigger card and it is not the
 * proposal detail's form-plus-aside either: a pair wants collation, not
 * a form. There is nothing to fill in — two records already exist and
 * the admin is reading them field by field, which is what an archivist
 * actually does — so the page is a single full-width column whose spine
 * is the comparison table.
 *
 * The table argues by contrast alone. Rows where the two records agree
 * recede; rows where they disagree hold. No badges, no "differs"
 * markers, no legend: the reader's eye lands on exactly the rows that
 * bear on the identity question. Below it the same three registers the
 * card carries, in the same order — the mechanical direction note (a
 * consequence, never a recommendation), the saffron ask (the scan never
 * recommends on identity), and the conversation.
 *
 * The question can go stale between the queue and this page, so the
 * loader refuses to render a settled one: a record already merged away,
 * or a pair whose decision row is ruled, redirects back to the queue,
 * which explains itself. Viewing files nothing — the decision row is
 * created on first DURABLE contact (a comment or a ruling), never by a
 * read.
 *
 * Permissions are the surface's: the admin guard and the `authorities`
 * capability here, the record-visibility scope on the reads, and the
 * pair mutation gate inside `rulePairKeepBoth` / `rulePairMerge` /
 * `getOrCreatePairDecision`. This route owns no ruling logic of its own.
 *
 * The conversation is writable here, not just readable: the thread is
 * handed the signed-in reader, and rewriting or retracting a comment
 * posts back as its own intent, gated by the comment module (author-only
 * edit, author-or-admin delete). Those two acts only ever reach a
 * comment that already exists, so unlike posting they never file the
 * pair's decision row — there is nothing to create when the thread is
 * already there.
 *
 * @version v0.7.0
 */

import { useEffect, useState } from "react";
import { Link, redirect, useNavigation, useSubmit } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { ChevronLeft, Merge } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import {
  DecisionThread,
  type ThreadComment,
} from "~/components/admin/decision-comment";
import { DismissDialog } from "~/components/admin/dismiss-dialog";
import { PairMergeDialog } from "~/components/admin/pair-merge-dialog";
import { AskPanel, SectionLabelRow } from "~/components/admin/decision-panels";
import {
  RecordCollation,
  type CollationField,
} from "~/components/admin/record-collation";
import { useFormatters } from "~/lib/use-formatters";
import type { Route } from "./+types/_auth.admin.decisions.pair";

type RecordKind = "entities" | "places";

/**
 * One side of the pair, flattened to the same shape whichever table it
 * came from — places carry no type, no lifespan, and no `sources`
 * column, so those arrive null rather than as a second record shape.
 */
interface PairRecordView {
  id: string;
  name: string;
  code: string;
  entityType: string | null;
  dates: string | null;
  nameVariants: string | null;
  sources: string | null;
  wikidataId: string | null;
  viafId: string | null;
  dbeId: string | null;
  tgnId: string | null;
  descriptionCount: number;
}

/** Narrow the `?type=` param; entities is the default worklist. */
function readKind(value: string | null): RecordKind {
  return value === "places" ? "places" : "entities";
}

/** Back to the queue the pair came from, on the same record type. */
function queuePath(kind: RecordKind): string {
  return `/admin/decisions/duplicates?type=${kind}`;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, inArray, isNull, or, sql } = await import("drizzle-orm");
  const {
    entities,
    places,
    descriptionEntities,
    descriptionPlaces,
    pendingDecisions,
  } = await import("~/db/schema");
  const { authorityScope } = await import("~/lib/authority-ownership.server");
  const { listDecisionComments, pairKey } = await import(
    "~/lib/pending-decisions.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);
  const search = new URL(request.url).searchParams;
  const kind = readKind(search.get("type"));
  const idA = search.get("a") ?? "";
  const idB = search.get("b") ?? "";
  if (!idA || !idB || idA === idB) {
    throw new Response("Not found", { status: 404 });
  }

  // Both records in one read, on the tenant's visible scope. A record
  // this tenant may not see is indistinguishable from one that does not
  // exist — both are this route's 404.
  const loaded =
    kind === "places"
      ? (
          await db
            .select({
              id: places.id,
              name: places.displayName,
              code: places.placeCode,
              nameVariants: places.nameVariants,
              tgnId: places.tgnId,
              mergedInto: places.mergedInto,
            })
            .from(places)
            .where(
              and(
                authorityScope(places, tenant.federationId, tenant.id),
                inArray(places.id, [idA, idB]),
              ),
            )
            .all()
        ).map((r) => ({
          id: r.id,
          name: r.name,
          code: r.code ?? "",
          entityType: null,
          dates: null,
          nameVariants: r.nameVariants,
          sources: null,
          wikidataId: null,
          viafId: null,
          dbeId: null,
          tgnId: r.tgnId,
          mergedInto: r.mergedInto,
        }))
      : (
          await db
            .select({
              id: entities.id,
              name: entities.displayName,
              code: entities.entityCode,
              entityType: entities.entityType,
              dates: entities.datesOfExistence,
              nameVariants: entities.nameVariants,
              sources: entities.sources,
              wikidataId: entities.wikidataId,
              viafId: entities.viafId,
              dbeId: entities.dbeId,
              mergedInto: entities.mergedInto,
            })
            .from(entities)
            .where(
              and(
                authorityScope(entities, tenant.federationId, tenant.id),
                inArray(entities.id, [idA, idB]),
              ),
            )
            .all()
        ).map((r) => ({
          id: r.id,
          name: r.name,
          code: r.code ?? "",
          entityType: r.entityType as string | null,
          dates: r.dates,
          nameVariants: r.nameVariants,
          sources: r.sources,
          wikidataId: r.wikidataId,
          viafId: r.viafId,
          dbeId: r.dbeId,
          tgnId: null,
          mergedInto: r.mergedInto,
        }));

  const a = loaded.find((r) => r.id === idA);
  const b = loaded.find((r) => r.id === idB);
  if (!a || !b) {
    throw new Response("Not found", { status: 404 });
  }

  // A settled question has nothing to collate. Either record already
  // merged away, or a ruled pair row, sends the reader back to the
  // queue rather than rendering a page whose buttons would 409.
  if (a.mergedInto || b.mergedInto) {
    throw redirect(queuePath(kind));
  }

  // Read-only: viewing a pair must not file its decision row. The row
  // exists here only if a comment or a ruling already reached it. Same
  // visibility shape as every other pending_decisions read (own or
  // shared) — the record gate above already guards this in practice,
  // but the read carries its own scope regardless.
  const decision = await db
    .select({ id: pendingDecisions.id, status: pendingDecisions.status })
    .from(pendingDecisions)
    .where(
      and(
        eq(pendingDecisions.federationId, tenant.federationId),
        or(
          isNull(pendingDecisions.tenantId),
          eq(pendingDecisions.tenantId, tenant.id),
        ),
        eq(pendingDecisions.kind, "duplicate-pair"),
        eq(pendingDecisions.sourceRef, pairKey(idA, idB)),
      ),
    )
    .get();
  if (decision?.status === "ruled") {
    throw redirect(queuePath(kind));
  }

  const comments = decision
    ? ((await listDecisionComments(db, [decision.id]))[decision.id] ?? [])
    : [];

  // The load each record carries — the consequence of merging, and the
  // input to the direction note and the dialog's preselection.
  const counts = new Map<string, number>();
  if (kind === "places") {
    const rows = await db
      .select({
        id: descriptionPlaces.placeId,
        count: sql<number>`count(*)`,
      })
      .from(descriptionPlaces)
      .where(inArray(descriptionPlaces.placeId, [idA, idB]))
      .groupBy(descriptionPlaces.placeId)
      .all();
    for (const r of rows) counts.set(r.id, r.count);
  } else {
    const rows = await db
      .select({
        id: descriptionEntities.entityId,
        count: sql<number>`count(*)`,
      })
      .from(descriptionEntities)
      .where(inArray(descriptionEntities.entityId, [idA, idB]))
      .groupBy(descriptionEntities.entityId)
      .all();
    for (const r of rows) counts.set(r.id, r.count);
  }

  const view = (r: (typeof loaded)[number]): PairRecordView => ({
    id: r.id,
    name: r.name,
    code: r.code,
    entityType: r.entityType,
    dates: r.dates,
    nameVariants: r.nameVariants,
    sources: r.sources,
    wikidataId: r.wikidataId,
    viafId: r.viafId,
    dbeId: r.dbeId,
    tgnId: r.tgnId,
    descriptionCount: counts.get(r.id) ?? 0,
  });

  return {
    kind,
    left: view(a),
    right: view(b),
    comments: comments as ThreadComment[],
    viewer: { userId: user.id, isAdmin: user.isAdmin },
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, inArray } = await import("drizzle-orm");
  const { entities, places } = await import("~/db/schema");
  const { authorityScope } = await import("~/lib/authority-ownership.server");
  const { addDecisionComment, getOrCreatePairDecision, rulePairKeepBoth } =
    await import("~/lib/pending-decisions.server");
  const { rulePairMerge } = await import("~/lib/pair-merge.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");
  const db = drizzle(context.cloudflare.env.DB);

  // The pair is addressed by the query string, exactly as the loader
  // reads it — the form carries only what the dialog collected.
  const search = new URL(request.url).searchParams;
  const kind = readKind(search.get("type"));
  const recordType = kind === "places" ? "place" : "entity";
  const idA = search.get("a") ?? "";
  const idB = search.get("b") ?? "";
  if (!idA || !idB || idA === idB) {
    throw new Response("Not found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = formData.get("_action");
  const reason = ((formData.get("reason") as string) || "").trim();

  // A comment is not a ruling: it files the pair's decision row if this
  // is its first durable contact, appends to the conversation, and
  // leaves the question open.
  if (intent === "comment") {
    const body = ((formData.get("body") as string) || "").trim();
    if (!body) return { ok: false as const, code: "invalid" as const };
    const decision = await getOrCreatePairDecision(
      db,
      user,
      tenant,
      recordType,
      idA,
      idB,
    );
    await addDecisionComment(
      db,
      decision.id,
      { userId: user.id, role: "admin" },
      body,
    );
    return { ok: true as const, code: "commented" as const };
  }

  // Rewriting or retracting a comment already on the thread. Both only
  // ever reach an existing row, so neither files the pair's decision
  // row — `getOrCreatePairDecision` has no part in them. The gate is
  // the comment module's, and every refusal it throws reads the same
  // here: the thread only needs to know the act did not land.
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

  try {
    if (intent === "keepBoth") {
      await rulePairKeepBoth(
        db,
        user,
        tenant,
        recordType,
        idA,
        idB,
        reason || null,
      );
    } else if (intent === "merge") {
      // The dialog confirms a CODE, because the code is what the admin
      // reads and what catalogue entries reference; the id it belongs
      // to is resolved here, on the scoped read, never trusted from the
      // form.
      const survivorCode = (
        (formData.get("survivorCode") as string) || ""
      ).trim();
      const table = kind === "places" ? places : entities;
      const codeCol = kind === "places" ? places.placeCode : entities.entityCode;
      const rows = await db
        .select({ id: table.id, code: codeCol })
        .from(table)
        .where(
          and(
            authorityScope(table, tenant.federationId, tenant.id),
            inArray(table.id, [idA, idB]),
          ),
        )
        .all();
      const survivor = rows.find((r) => r.code === survivorCode);
      const loser = rows.find((r) => r.id !== survivor?.id);
      if (rows.length !== 2 || !survivor || !loser) {
        return { ok: false as const, code: "generic" as const };
      }
      await rulePairMerge(
        db,
        user,
        tenant,
        recordType,
        survivor.id,
        loser.id,
        reason || null,
      );
    } else {
      return { ok: false as const, code: "generic" as const };
    }
  } catch (err) {
    // 409 is this surface's whole concurrency story — a record merged
    // away underneath, or the pair ruled by someone else. It belongs on
    // the page as translated feedback; the error's own text never does.
    if (err instanceof Response) {
      return {
        ok: false as const,
        code: err.status === 409 ? ("conflict" as const) : ("generic" as const),
      };
    }
    throw err;
  }

  // Ruled: the question is gone, so the reader goes back to the queue.
  return redirect(queuePath(kind));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DecisionPairPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { t } = useTranslation("decisions");
  const { t: te } = useTranslation("entities");
  const { t: tp } = useTranslation("places");
  const { t: ta } = useTranslation("authorities");
  const { formatNumber } = useFormatters();
  const { kind, left, right, comments, viewer } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const pending = navigation.state !== "idle";
  const [dialog, setDialog] = useState<"keep" | "merge" | null>(null);

  // A ruling that came back with a coded failure leaves the dialog in
  // the way of its own error message; close it as the submission lands.
  useEffect(() => {
    if (navigation.state === "idle" && actionData) setDialog(null);
  }, [navigation.state, actionData]);

  // Static maps, one entry per key: the copy each shape needs is
  // resolved up front rather than assembled from a key fragment.
  const questionByShape: Record<string, string> = {
    person: t("pairQuestion_person"),
    family: t("pairQuestion_family"),
    corporate: t("pairQuestion_corporate"),
    place: t("pairQuestion_place"),
    generic: t("pairQuestion_generic"),
  };
  const whySameByShape: Record<string, string> = {
    person: t("whySame_person"),
    family: t("whySame_family"),
    corporate: t("whySame_corporate"),
    place: t("whySame_place"),
    generic: t("whySame_generic"),
  };
  const whyDifferentByShape: Record<string, string> = {
    person: t("whyDifferent_person"),
    family: t("whyDifferent_family"),
    corporate: t("whyDifferent_corporate"),
    place: t("whyDifferent_place"),
    generic: t("whyDifferent_generic"),
  };
  const typeLabelByType: Record<string, string> = {
    person: t("typePerson"),
    family: t("typeFamily"),
    corporate: t("typeCorporate"),
    place: t("typePlace"),
  };

  // Places are always the place shape; entities take their shared type,
  // and a pair that disagrees about type asks the generic question.
  const shape =
    kind === "places"
      ? "place"
      : left.entityType && left.entityType === right.entityType
        ? left.entityType
        : "generic";
  const question = questionByShape[shape] ?? questionByShape.generic;
  const whySame = whySameByShape[shape] ?? whySameByShape.generic;
  const whyDifferent =
    whyDifferentByShape[shape] ?? whyDifferentByShape.generic;
  const typeLabel = (record: PairRecordView): string =>
    kind === "places"
      ? typeLabelByType.place
      : (typeLabelByType[record.entityType ?? ""] ?? "");

  // The object of the decision: one name when both records answer to
  // it, both names otherwise.
  const object =
    left.name.trim() === right.name.trim()
      ? left.name.trim()
      : `${left.name} · ${right.name}`;

  const countLeft = left.descriptionCount;
  const countRight = right.descriptionCount;
  const heavier = countLeft > countRight ? left : right;
  const heavierCount = Math.max(countLeft, countRight);

  const loadLine = (count: number): string =>
    count > 0
      ? t("pairLoad", { count, formattedCount: formatNumber(count) })
      : t("pairLoadNone");

  // Direction is mechanical, never a judgement — an even load has no
  // direction to state, and an equal non-zero load says nothing either.
  const directionNote =
    countLeft === 0 && countRight === 0 ? (
      t("dirEven")
    ) : countLeft !== countRight ? (
      <Trans
        i18nKey="dirUneven"
        ns="decisions"
        count={heavierCount}
        values={{
          code: heavier.code,
          formattedCount: formatNumber(heavierCount),
        }}
        components={[
          <span key="code" className="font-mono text-11 text-indigo-soft" />,
        ]}
      />
    ) : null;

  // Preselect the record carrying the descriptions; an equal load —
  // zero or not — leaves the choice to the admin.
  const defaultSurvivorCode =
    countLeft === countRight ? null : heavier.code;

  // The comparison table. Labels are the record editors' own field
  // labels, so the page names fields the way every other surface does.
  const variantList = (json: string | null): string => {
    try {
      const parsed = JSON.parse(json || "[]");
      return Array.isArray(parsed) && parsed.length > 0
        ? parsed.join(", ")
        : "—";
    } catch {
      return "—";
    }
  };
  // First NON-EMPTY line, matching the queue's rule — a sources field
  // that opens with a blank line still has provenance to show.
  const provenanceLine = (sources: string | null): string =>
    (sources || "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || t("pairProvNone");

  const fields: CollationField[] = [
    {
      label: kind === "places" ? tp("field.displayName") : te("field.displayName"),
      a: left.name,
      b: right.name,
    },
    {
      label: kind === "places" ? tp("field.placeType") : te("field.entityType"),
      a: typeLabel(left),
      b: typeLabel(right),
    },
  ];
  if (kind !== "places") {
    fields.push({
      label: te("field.datesOfExistence"),
      a: left.dates ?? "—",
      b: right.dates ?? "—",
    });
  }
  // External identifiers: one row per identifier the merge workbench
  // compares, and none at all where neither record carries the id.
  const identifiers =
    kind === "places"
      ? [{ label: tp("field.tgnId"), a: left.tgnId, b: right.tgnId }]
      : [
          {
            label: te("field.wikidataId"),
            a: left.wikidataId,
            b: right.wikidataId,
          },
          { label: te("field.viafId"), a: left.viafId, b: right.viafId },
          { label: te("field.dbeId"), a: left.dbeId, b: right.dbeId },
        ];
  for (const row of identifiers) {
    if (!row.a && !row.b) continue;
    fields.push({ label: row.label, a: row.a ?? "—", b: row.b ?? "—" });
  }
  fields.push(
    {
      label:
        kind === "places" ? tp("field.nameVariants") : te("field.nameVariants"),
      a: variantList(left.nameVariants),
      b: variantList(right.nameVariants),
    },
    // Places carry no sources column, so their provenance row would be
    // two permanent fallbacks — dropped rather than rendered as noise.
    ...(kind !== "places"
      ? [
          {
            label: te("field.sources"),
            a: provenanceLine(left.sources),
            b: provenanceLine(right.sources),
          },
        ]
      : []),
    {
      label: ta("mergeLinksHeading"),
      a: loadLine(countLeft),
      b: loadLine(countRight),
    },
  );

  // Comment acts post through the thread's own fetcher and never reach
  // actionData; failures report themselves inside the thread, so the
  // page banner is always the ruling's.
  const errorMessage =
    actionData && actionData.ok === false
      ? t(
          actionData.code === "conflict"
            ? "pairErrorConflict"
            : actionData.code === "invalid"
              ? "errorInvalid"
              : "errorGeneric",
        )
      : null;

  const textareaClass =
    "mt-1.5 block h-[60px] w-full max-w-[44rem] resize-none rounded-lg border border-stone-300 bg-white p-3 text-sm leading-normal text-stone-700 placeholder:text-stone-400 focus:border-verdigris focus:outline-none focus:ring-1 focus:ring-verdigris";

  return (
    <div className="mx-auto max-w-[960px] bg-white px-7 pb-7 pt-[22px]">
      <Link
        to={queuePath(kind)}
        className="inline-flex items-center gap-[5px] text-13 font-medium text-stone-500 hover:text-indigo"
      >
        <ChevronLeft className="h-[15px] w-[15px]" strokeWidth={1.75} />
        {t("backToQueue")}
      </Link>

      <h1 className="mt-5 font-serif text-2xl font-semibold leading-tight tracking-[-0.01em] text-indigo">
        {object}
      </h1>
      <p className="mt-[3px] text-13 text-stone-500">{t("pairContext")}</p>

      <RecordCollation
        fields={fields}
        leftCode={left.code}
        rightCode={right.code}
      />

      {directionNote ? (
        <p className="mt-2.5 text-xs leading-[1.5] text-stone-500 [text-wrap:pretty]">
          {directionNote}
        </p>
      ) : null}

      {/* The scan asks; it never recommends on identity */}
      <AskPanel value={question} judgement eyebrow={t("askQuestionEyebrow")} />

      <SectionLabelRow label={t("commentsHeading")} />
      {comments.length > 0 && (
        <div className="mt-3">
          <DecisionThread comments={comments} viewer={viewer} />
        </div>
      )}

      {/* Anyone entitled to see the pair may add to its conversation;
          ruling stays a separate act. */}
      <form method="post" className="mt-4 border-t border-stone-200 pt-4">
        <label
          className="block text-sm font-medium text-stone-700"
          htmlFor="pair-comment-body"
        >
          {t("addComment")}
        </label>
        <textarea
          id="pair-comment-body"
          name="body"
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

      {/* Page-level actions, so both sit at the dialog tier. Neither
          rules on its own — each opens its confirmation first. */}
      <div className="mt-5 flex items-center justify-end gap-2.5 border-t border-stone-200 pt-4">
        <button
          type="button"
          onClick={() => setDialog("keep")}
          disabled={pending}
          className="inline-flex h-11 items-center rounded-lg border border-stone-300 bg-white px-4.5 text-15 font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t("keepBoth")}
        </button>
        <button
          type="button"
          onClick={() => setDialog("merge")}
          disabled={pending}
          className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-verdigris pl-4 pr-4.5 text-15 font-semibold text-white hover:bg-verdigris-deep disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Merge size={16} strokeWidth={1.75} />
          {t("mergeIntoOne")}
        </button>
      </div>

      {errorMessage && (
        <p className="mt-3 text-13 text-madder-deep">{errorMessage}</p>
      )}

      {/* Keep both is final but destroys nothing — the neutral tone */}
      {dialog === "keep" && (
        <DismissDialog
          tone="neutral"
          title={t("keepBothModalTitle", { name: object })}
          body={t("keepBothModalBody")}
          confirmLabel={t("keepBoth")}
          reasonPlaceholder={whyDifferent}
          pending={pending}
          onCancel={() => setDialog(null)}
          onConfirm={(reason) =>
            submit({ _action: "keepBoth", reason }, { method: "post" })
          }
        />
      )}

      {/* Merge never happens without the direction step */}
      {dialog === "merge" && (
        <PairMergeDialog
          title={t("mergeModalTitle", { name: object })}
          options={[
            { code: left.code, loadLine: loadLine(countLeft) },
            { code: right.code, loadLine: loadLine(countRight) },
          ]}
          defaultSurvivorCode={defaultSurvivorCode}
          reasonPlaceholder={whySame}
          pending={pending}
          onCancel={() => setDialog(null)}
          onConfirm={(survivorCode, reason) =>
            submit(
              { _action: "merge", survivorCode, reason },
              { method: "post" },
            )
          }
        />
      )}
    </div>
  );
}
