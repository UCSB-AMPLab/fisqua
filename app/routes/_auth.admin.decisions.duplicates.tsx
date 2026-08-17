/**
 * Pending Decisions — Possible duplicates tab
 *
 * The two authority duplicates queues — entities and places — as one
 * tab of the Pending decisions surface, switched by `?type=` (entities
 * by default) and filtered by `?status=` (open by default). Candidates
 * are still computed deterministically on every request by
 * `computeDuplicateCandidates` over the federation's active records;
 * the scan library is untouched. What changed is the unit of work: the
 * old two-column worklist row is now a `DuplicatePairCard`, the card
 * language the rest of this surface already speaks.
 *
 * A card is a question, not a form. The scan finds a pair but does not
 * recommend on identity, so the ask stays saffron and open; the
 * direction line below the panes states the mechanical consequence of
 * merging — which code would survive, because the alternative orphans
 * the descriptions pointing at the other — and never reads as a
 * recommendation. Provenance sits above the pane hairline as evidence
 * of identity; the description load sits below it as consequence.
 *
 * Two rulings, and neither is immediate:
 *
 *   Keep both  the neutral-tone `DismissDialog`. Nothing is destroyed,
 *              but the question closes for good, so it still confirms.
 *              `rulePairKeepBoth` owns the dual write — the ruled
 *              decision row the surface reads and the `separate`
 *              ledger entry, one batch.
 *   Merge      `PairMergeDialog`, where the surviving code is chosen.
 *              `rulePairMerge` repoints every link, folds the loser's
 *              names in, and rules the pair, again in one batch.
 *
 * The route writes nothing itself: it resolves the two records, hands
 * the ruling to the server function, and turns a thrown `Response`
 * into a translated line. The reason is optional on both dialogs —
 * `rulePairKeepBoth` accepts null, and the earlier worklist's
 * required-reason rejection went with the worklist.
 *
 * Ruled pairs are subtracted from BOTH dismissal stores: the `separate`
 * ledger operations the scan has always excluded, unioned with ruled
 * `duplicate-pair` rows in `pending_decisions` (0072 — open pair rows
 * keep appearing until someone rules them). The `?status=ruled` view
 * reads those ruled rows back, newest first, so a ruling stays
 * retrievable without being reopenable.
 *
 * Gating is what the moved pages carried: admin plus the `authorities`
 * capability on loader and action. The pair rule itself lives inside
 * the two server functions — unrestricted when this tenant owns both
 * records, steward-gated otherwise, 404 when either belongs to another
 * tenant.
 *
 * @version v0.7.0
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useFetcher, useNavigate, useSearchParams } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { CheckCheck } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { SaveFeedbackBanner } from "~/components/admin/save-feedback";
import {
  DecisionThread,
  type ThreadComment,
} from "~/components/admin/decision-comment";
import { DismissDialog } from "~/components/admin/dismiss-dialog";
import {
  DuplicatePairCard,
  type PairPaneRecord,
} from "~/components/admin/duplicate-pair-card";
import { PairMergeDialog } from "~/components/admin/pair-merge-dialog";
import { useFormatters } from "~/lib/use-formatters";
import type { CandidateRecord } from "~/lib/authority-duplicates.server";
// Type-only: `pending-decisions.server` must never reach the client
// bundle, so only the payload shape travels through this import.
import type { DuplicatePairPayload } from "~/lib/pending-decisions.server";
import type { Route } from "./+types/_auth.admin.decisions.duplicates";

/** Cap the rendered queue; the count line reflects the full number. */
const MAX_PAIRS = 50;

/** Ruled pairs rendered in the `?status=ruled` view. */
const MAX_RULED = 50;

/**
 * Ruled rows read before the record-type filter runs. A pair's record
 * type lives inside the decision payload, so the filter cannot run in
 * SQL without reaching into the JSON; the loader reads a window
 * several times the render cap and narrows it in memory instead.
 */
const RULED_SCAN = MAX_RULED * 4;

/** Longest provenance line a pane carries before it is cut. */
const PROVENANCE_CHARS = 140;

type RecordKind = "entities" | "places";
type QueueStatus = "open" | "ruled";
type EntityType = "person" | "family" | "corporate";

/** Narrow the `?type=` param; entities is the default queue. */
function readKind(value: string | null): RecordKind {
  return value === "places" ? "places" : "entities";
}

/** Narrow the `?status=` param to the two the queue understands. */
function readStatus(value: string | null): QueueStatus {
  return value === "ruled" ? "ruled" : "open";
}

/** One record of a flagged pair, as the card's pane reads it. */
interface PairSide {
  id: string;
  name: string;
  /**
   * Authority code, falling back to the id when a record carries none:
   * the merge dialog identifies the survivor by this string, so it has
   * to be unique within the pair.
   */
  code: string;
  /** Entities only; places take the place type label instead. */
  entityType: EntityType | null;
  /** First provenance line, already cut; null when none is recorded. */
  provenance: string | null;
  descriptionCount: number;
}

interface PairView {
  /** The decision `sourceRef` — sorted-id pair key. */
  key: string;
  a: PairSide;
  b: PairSide;
  comments: ThreadComment[];
}

/** A pair that has been ruled, as the ruled view reads it. */
interface RuledPairRow {
  id: string;
  names: [string, string];
  codes: [string, string];
  ruling: string | null;
  /** Merged rulings only: the code that survived. */
  survivorCode: string | null;
  rulingNote: string | null;
  ruledAt: number | null;
}

/**
 * What the action hands back: a coded outcome, never prose. The copy
 * lives in the locale bundle, so the server modules stay free of
 * user-facing English.
 */
type PairRulingResult =
  | { ok: true; ruling: "kept_both" | "merged" }
  | { ok: false; code: "conflict" | "generic" };

/**
 * The scan's record shape plus the two columns the card needs and the
 * candidate computation does not: the entity type behind the pane's
 * type label, and the provenance prose behind its evidence line.
 */
type ScanRecord = CandidateRecord & {
  entityType?: EntityType;
  sources?: string | null;
};

/**
 * The pane's evidence line: the first non-empty line of the record's
 * provenance, cut at a word boundary. Places have no `sources` column,
 * so their panes fall through to the "none recorded" line.
 */
function firstProvenanceLine(sources: string | null | undefined): string | null {
  const first = (sources ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return null;
  if (first.length <= PROVENANCE_CHARS) return first;
  const cut = first.slice(0, PROVENANCE_CHARS);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { authorityScope } = await import("~/lib/authority-ownership.server");
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, desc, eq, inArray, isNull, or, sql } = await import(
    "drizzle-orm"
  );
  const {
    entities,
    places,
    descriptionEntities,
    descriptionPlaces,
    pendingDecisions,
  } = await import("~/db/schema");
  const { computeDuplicateCandidates, getSeparatePairs } = await import(
    "~/lib/authority-duplicates.server"
  );
  const { listDecisionComments, pairKey, ruledPairKeys } = await import(
    "~/lib/pending-decisions.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);
  const url = new URL(request.url);
  const kind = readKind(url.searchParams.get("type"));
  const status = readStatus(url.searchParams.get("status"));
  const recordType = kind === "places" ? "place" : "entity";
  const table = kind === "places" ? places : entities;

  // The questions this tenant may see: its own plus the shared ones —
  // the same visibility shape `authorityScope` builds over records.
  const decisionScope = and(
    eq(pendingDecisions.federationId, tenant.federationId),
    or(
      isNull(pendingDecisions.tenantId),
      eq(pendingDecisions.tenantId, tenant.id),
    ),
  );

  // -- Ruled view -------------------------------------------------------
  // A closed question is not a candidate, so the scan has nothing to
  // say here: the ruled rows themselves are the list.
  if (status === "ruled") {
    const scanned = await db
      .select({
        id: pendingDecisions.id,
        payload: pendingDecisions.payload,
        ruling: pendingDecisions.ruling,
        resultId: pendingDecisions.resultId,
        rulingNote: pendingDecisions.rulingNote,
        ruledAt: pendingDecisions.ruledAt,
      })
      .from(pendingDecisions)
      .where(
        and(
          decisionScope,
          eq(pendingDecisions.kind, "duplicate-pair"),
          eq(pendingDecisions.status, "ruled"),
        ),
      )
      .orderBy(desc(pendingDecisions.ruledAt))
      .limit(RULED_SCAN)
      .all();

    const matching: Array<{ row: (typeof scanned)[number]; pair: [string, string] }> =
      [];
    for (const row of scanned) {
      const payload = JSON.parse(row.payload) as DuplicatePairPayload;
      if (payload.recordType !== recordType) continue;
      matching.push({ row, pair: payload.pair });
      if (matching.length >= MAX_RULED) break;
    }

    // Names and codes for both sides plus the survivor, in one read.
    // Merged-away records are deliberately not excluded — the loser of
    // a merge is exactly what a ruled row has to be able to name.
    const wanted = Array.from(
      new Set(
        matching.flatMap(({ row, pair }) =>
          row.resultId ? [...pair, row.resultId] : [...pair],
        ),
      ),
    );
    const named = new Map<string, { name: string; code: string | null }>();
    if (wanted.length > 0) {
      const records = await db
        .select({
          id: table.id,
          name: table.displayName,
          code: kind === "places" ? places.placeCode : entities.entityCode,
        })
        .from(table as any)
        .where(
          and(
            authorityScope(table, tenant.federationId, tenant.id),
            inArray(table.id, wanted),
          ),
        )
        .all();
      for (const r of records) named.set(r.id, { name: r.name, code: r.code });
    }
    const nameOf = (id: string) => {
      const record = named.get(id);
      return record?.name ?? record?.code ?? "";
    };

    const ruled: RuledPairRow[] = matching.map(({ row, pair }) => ({
      id: row.id,
      names: [nameOf(pair[0]), nameOf(pair[1])],
      codes: [named.get(pair[0])?.code ?? "", named.get(pair[1])?.code ?? ""],
      ruling: row.ruling,
      survivorCode:
        row.ruling === "merged" && row.resultId
          ? (named.get(row.resultId)?.code ?? null)
          : null,
      rulingNote: row.rulingNote,
      ruledAt: row.ruledAt,
    }));

    const pairs: PairView[] = [];
    return { kind, status, pairs, ruled, totalPairs: 0, truncated: false };
  }

  // -- Open view --------------------------------------------------------
  // Candidate records. Entities carry lifespan dates as a tie-signal,
  // their type for the pane label, and their provenance prose; places
  // have none of the three, so they pass the name and the shared TGN id.
  const rows: ScanRecord[] =
    kind === "places"
      ? await db
          .select({
            id: places.id,
            name: places.displayName,
            code: places.placeCode,
            externalId: places.tgnId,
          })
          .from(places)
          .where(
            and(
              authorityScope(places, tenant.federationId, tenant.id),
              isNull(places.mergedInto),
            ),
          )
          .all()
      : await db
          .select({
            id: entities.id,
            name: entities.displayName,
            code: entities.entityCode,
            dateStart: entities.dateStart,
            dateEnd: entities.dateEnd,
            dates: entities.datesOfExistence,
            externalId: entities.wikidataId,
            entityType: entities.entityType,
            sources: entities.sources,
          })
          .from(entities)
          .where(
            and(
              authorityScope(entities, tenant.federationId, tenant.id),
              isNull(entities.mergedInto),
            ),
          )
          .all();

  // Both dismissal stores, unioned into the one set the scan already
  // takes. Same key shape on both sides (sorted-id pair key).
  const [separatePairs, ruledKeys] = await Promise.all([
    getSeparatePairs(db, tenant.federationId, recordType),
    ruledPairKeys(db, tenant, recordType),
  ]);
  for (const key of ruledKeys) separatePairs.add(key);

  const { pairs: allPairs, truncated } = computeDuplicateCandidates(
    rows,
    separatePairs,
  );
  const visible = allPairs.slice(0, MAX_PAIRS);

  // Link counts for the records on the visible cards only.
  const visibleIds = Array.from(
    new Set(visible.flatMap((p) => [p.a.id, p.b.id])),
  );
  const linkCounts = new Map<string, number>();
  if (visibleIds.length > 0) {
    if (kind === "places") {
      const counts = await db
        .select({
          placeId: descriptionPlaces.placeId,
          count: sql<number>`count(*)`,
        })
        .from(descriptionPlaces)
        .where(inArray(descriptionPlaces.placeId, visibleIds))
        .groupBy(descriptionPlaces.placeId)
        .all();
      for (const c of counts) linkCounts.set(c.placeId, c.count);
    } else {
      const counts = await db
        .select({
          entityId: descriptionEntities.entityId,
          count: sql<number>`count(*)`,
        })
        .from(descriptionEntities)
        .where(inArray(descriptionEntities.entityId, visibleIds))
        .groupBy(descriptionEntities.entityId)
        .all();
      for (const c of counts) linkCounts.set(c.entityId, c.count);
    }
  }

  // The conversation on the visible pairs. A pair only has a decision
  // row once someone has touched it (0072 files it lazily), so this is
  // a left-join in two steps rather than a required read: pairs with no
  // row simply carry no thread.
  const visibleKeys = visible.map((p) => pairKey(p.a.id, p.b.id));
  const commentsByPair: Record<string, ThreadComment[]> = {};
  if (visibleKeys.length > 0) {
    const decisions = await db
      .select({ id: pendingDecisions.id, sourceRef: pendingDecisions.sourceRef })
      .from(pendingDecisions)
      .where(
        and(
          decisionScope,
          eq(pendingDecisions.kind, "duplicate-pair"),
          inArray(pendingDecisions.sourceRef, visibleKeys),
        ),
      )
      .all();
    if (decisions.length > 0) {
      const threads = await listDecisionComments(
        db,
        decisions.map((d) => d.id),
      );
      for (const d of decisions) {
        const thread = threads[d.id];
        if (d.sourceRef && thread?.length) commentsByPair[d.sourceRef] = thread;
      }
    }
  }

  const detail = new Map(rows.map((r) => [r.id, r] as const));
  const sideOf = (record: CandidateRecord): PairSide => {
    const full = detail.get(record.id);
    return {
      id: record.id,
      name: record.name,
      code: record.code ?? record.id,
      entityType: full?.entityType ?? null,
      provenance: firstProvenanceLine(full?.sources),
      descriptionCount: linkCounts.get(record.id) ?? 0,
    };
  };

  const pairs: PairView[] = visible.map((p) => {
    const key = pairKey(p.a.id, p.b.id);
    return {
      key,
      a: sideOf(p.a),
      b: sideOf(p.b),
      comments: commentsByPair[key] ?? [],
    };
  });

  const ruled: RuledPairRow[] = [];
  return {
    kind,
    status,
    pairs,
    ruled,
    totalPairs: allPairs.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { authorityScope } = await import("~/lib/authority-ownership.server");
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, inArray, isNull } = await import("drizzle-orm");
  const { entities, places } = await import("~/db/schema");
  const { rulePairKeepBoth } = await import("~/lib/pending-decisions.server");
  const { rulePairMerge } = await import("~/lib/pair-merge.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");
  const db = drizzle(context.cloudflare.env.DB);

  const formData = await request.formData();
  const intent = formData.get("_action");
  if (intent !== "keepBoth" && intent !== "merge") {
    return { ok: false as const, code: "generic" as const };
  }

  // Which queue the pair came from. The field is a hint about which
  // table to read, never an authorisation input: the scope predicate
  // here and the pair gate inside the ruling functions both re-derive
  // the answer.
  const submittedKind = formData.get("recordKind");
  const kind = readKind(
    typeof submittedKind === "string"
      ? submittedKind
      : new URL(request.url).searchParams.get("type"),
  );
  const recordType = kind === "places" ? "place" : "entity";

  // Keep both names the pair in either order; a merge names the
  // survivor first, because that is the choice the dialog collected.
  const first =
    ((formData.get(intent === "merge" ? "survivorId" : "idA") as string) || "")
      .trim();
  const second =
    ((formData.get(intent === "merge" ? "loserId" : "idB") as string) || "")
      .trim();
  const reason = ((formData.get("reason") as string) || "").trim() || null;
  if (!first || !second || first === second) {
    return { ok: false as const, code: "generic" as const };
  }

  // Both records must be live in this federation and visible to this
  // tenant — a ruling names two real records, never arbitrary ids. The
  // ownership gate inside the ruling functions is the authorisation
  // check; this is the existence check that keeps a bogus id out of the
  // ledger and out of `pending_decisions`.
  const table = kind === "places" ? places : entities;
  const live = await db
    .select({ id: table.id })
    .from(table as any)
    .where(
      and(
        authorityScope(table, tenant.federationId, tenant.id),
        inArray(table.id, [first, second]),
        isNull(table.mergedInto),
      ),
    )
    .all();
  if (live.length !== 2) {
    return { ok: false as const, code: "generic" as const };
  }

  try {
    if (intent === "merge") {
      await rulePairMerge(db, user, tenant, recordType, first, second, reason);
    } else {
      await rulePairKeepBoth(
        db,
        user,
        tenant,
        recordType,
        first,
        second,
        reason,
      );
    }
  } catch (err) {
    // A pair someone else has already ruled is the whole concurrency
    // story on this surface, and it belongs on the page as a line the
    // admin can read. Anything else the ruling refused is reported in
    // the same register — never the thrown response's own text.
    if (err instanceof Response) {
      return {
        ok: false as const,
        code: err.status === 409 ? ("conflict" as const) : ("generic" as const),
      };
    }
    throw err;
  }

  return {
    ok: true as const,
    ruling: intent === "merge" ? ("merged" as const) : ("kept_both" as const),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Which question, reason, and type wording a pair takes. */
type PairFlavour = EntityType | "place" | "generic";

export default function DecisionDuplicatesPage({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("decisions");
  const { t: ta } = useTranslation("authorities");
  const { t: tc } = useTranslation("common");
  const { formatDate, formatNumber } = useFormatters();
  const { kind, status, pairs, ruled, totalPairs, truncated } = loaderData;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const fetcher = useFetcher<PairRulingResult>();
  const [dialog, setDialog] = useState<{
    kind: "keep" | "merge";
    pair: PairView;
  } | null>(null);

  const pending = fetcher.state !== "idle";

  // Translate the action's coded result into the shape the shared
  // banner reads. The action returns codes, not prose, so the copy
  // stays in the locale bundle rather than in the server modules.
  const feedbackSource = useMemo(() => {
    const data = fetcher.data;
    if (!data) return undefined;
    if (data.ok)
      return {
        ok: true,
        message:
          data.ruling === "merged"
            ? t("feedbackPairMerged")
            : t("feedbackPairKeptBoth"),
      };
    return {
      ok: false,
      error: data.code === "conflict" ? t("pairErrorConflict") : t("errorGeneric"),
    };
  }, [fetcher.data, t, tc]);

  // The dialog belongs to a pair that leaves the queue the moment the
  // ruling lands; close it as soon as the submission comes back.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setDialog(null);
  }, [fetcher.state, fetcher.data]);

  // Static key maps, one translated value per flavour. The pair's
  // flavour picks the entry; no key is ever assembled from data.
  const typeLabels: Record<EntityType | "place", string> = {
    person: t("typePerson"),
    family: t("typeFamily"),
    corporate: t("typeCorporate"),
    place: t("typePlace"),
  };
  const questions: Record<PairFlavour, string> = {
    person: t("pairQuestion_person"),
    family: t("pairQuestion_family"),
    corporate: t("pairQuestion_corporate"),
    place: t("pairQuestion_place"),
    generic: t("pairQuestion_generic"),
  };
  const whySame: Record<PairFlavour, string> = {
    person: t("whySame_person"),
    family: t("whySame_family"),
    corporate: t("whySame_corporate"),
    place: t("whySame_place"),
    generic: t("whySame_generic"),
  };
  const whyDifferent: Record<PairFlavour, string> = {
    person: t("whyDifferent_person"),
    family: t("whyDifferent_family"),
    corporate: t("whyDifferent_corporate"),
    place: t("whyDifferent_place"),
    generic: t("whyDifferent_generic"),
  };

  /** Places ask about a place; entities ask about their shared type. */
  const flavourOf = (pair: PairView): PairFlavour => {
    if (kind === "places") return "place";
    if (pair.a.entityType && pair.a.entityType === pair.b.entityType) {
      return pair.a.entityType;
    }
    return "generic";
  };

  /** The shared name, or both names when the two forms differ. */
  const objectOf = (pair: PairView): string => {
    const a = pair.a.name.trim();
    const b = pair.b.name.trim();
    return a === b ? a : `${pair.a.name} · ${pair.b.name}`;
  };

  const loadLine = (count: number): string =>
    count > 0
      ? t("pairLoad", { count, formattedCount: formatNumber(count) })
      : t("pairLoadNone");

  const paneOf = (side: PairSide): PairPaneRecord => ({
    code: side.code,
    typeLabel:
      kind === "places"
        ? typeLabels.place
        : side.entityType
          ? typeLabels[side.entityType]
          : "",
    provenance: side.provenance ?? t("pairProvNone"),
    descriptionCount: side.descriptionCount,
  });

  /**
   * The mechanical consequence of merging, never a recommendation:
   * the heavier side survives because the alternative orphans its
   * descriptions. An even load leaves the choice open and says so; an
   * even NON-zero load says nothing at all.
   */
  const directionNote = (pair: PairView): React.ReactNode | undefined => {
    const a = pair.a.descriptionCount;
    const b = pair.b.descriptionCount;
    if (a === 0 && b === 0) return t("dirEven");
    if (a === b) return undefined;
    const survivor = a > b ? pair.a : pair.b;
    const count = Math.max(a, b);
    return (
      <Trans
        i18nKey="dirUneven"
        ns="decisions"
        count={count}
        values={{ code: survivor.code, formattedCount: formatNumber(count) }}
        components={[
          <span key="code" className="font-mono text-11 text-indigo-soft" />,
        ]}
      />
    );
  };

  /** The survivor the dialog chose, mapped back onto the two records. */
  const submitMerge = (pair: PairView, survivorCode: string, reason: string) => {
    const survivor = survivorCode === pair.a.code ? pair.a : pair.b;
    const loser = survivor.id === pair.a.id ? pair.b : pair.a;
    fetcher.submit(
      {
        _action: "merge",
        recordKind: kind,
        survivorId: survivor.id,
        loserId: loser.id,
        reason,
      },
      { method: "post" },
    );
  };

  const submitKeepBoth = (pair: PairView, reason: string) => {
    fetcher.submit(
      {
        _action: "keepBoth",
        recordKind: kind,
        idA: pair.a.id,
        idB: pair.b.id,
        reason,
      },
      { method: "post" },
    );
  };

  const kindLink = (next: RecordKind) => {
    const params = new URLSearchParams(searchParams);
    params.set("type", next);
    return `?${params.toString()}`;
  };

  const statusLink = (next: QueueStatus) => {
    const params = new URLSearchParams(searchParams);
    params.set("status", next);
    return `?${params.toString()}`;
  };

  const chipClass = (active: boolean) =>
    `rounded-full px-3 py-1 text-13 font-semibold transition-colors ${
      active
        ? "bg-indigo text-parchment"
        : "border border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
    }`;

  return (
    <div>
      {/* Record-type toggle — the surface's tab bar sits above, so this
          reads as a filter rather than a second level of navigation. */}
      <nav className="mt-6 flex gap-2">
        {(["entities", "places"] as const).map((value) => (
          <Link key={value} to={kindLink(value)} className={chipClass(kind === value)}>
            {value === "entities" ? t("dupTypeEntities") : t("dupTypePlaces")}
          </Link>
        ))}
      </nav>

      {/* Open / ruled filter, in the proposals tab's idiom */}
      <nav className="mt-2 flex gap-2">
        {(["open", "ruled"] as const).map((value) => (
          <Link
            key={value}
            to={statusLink(value)}
            className={chipClass(status === value)}
          >
            {value === "open" ? t("filterOpen") : t("filterRuled")}
          </Link>
        ))}
      </nav>

      <p className="mt-3 text-13 text-stone-500">{t("dupDismissedNote")}</p>

      <div className="mt-4">
        <SaveFeedbackBanner
          source={feedbackSource}
          pending={pending}
          labels={{ success: tc("save.saved"), error: t("errorGeneric") }}
        />
      </div>

      {status === "ruled" ? (
        <RuledPairList
          rows={ruled}
          t={t}
          formatDate={formatDate}
          emptyHeading={t("emptyRuledHeading")}
        />
      ) : pairs.length === 0 ? (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-stone-200 px-6 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-md bg-verdigris-tint">
            <CheckCheck className="h-5 w-5 text-verdigris-deep" strokeWidth={1.5} />
          </span>
          <p className="font-serif text-xl text-indigo">{ta("dupEmptyHeading")}</p>
          <p className="measure-36 text-13 text-stone-500">{ta("dupEmptyBody")}</p>
        </div>
      ) : (
        <>
          {/* Count line — the FULL candidate count; a trailing "+" when
              the computation itself was capped, and an explicit
              showing-of note when the render cap hides pairs */}
          <p className="mt-6 text-13 nums text-stone-500">
            <span className="font-semibold text-indigo">
              {totalPairs}
              {truncated ? "+" : ""}
            </span>{" "}
            {ta("dupCountLine")}
            {(pairs.length < totalPairs || truncated) && (
              <span className="text-stone-400">
                {" · "}
                {ta("dupShowing", {
                  shown: pairs.length,
                  total: `${totalPairs}${truncated ? "+" : ""}`,
                })}
              </span>
            )}
          </p>

          <div className="mt-3 flex flex-col gap-3">
            {pairs.map((pair) => (
              <DuplicatePairCard
                key={pair.key}
                object={objectOf(pair)}
                contextLine={t("pairContext")}
                left={paneOf(pair.a)}
                right={paneOf(pair.b)}
                question={questions[flavourOf(pair)]}
                directionNote={directionNote(pair)}
                pending={pending}
                onLookCloser={() =>
                  navigate(
                    `/admin/decisions/pair?type=${kind}&a=${pair.a.id}&b=${pair.b.id}`,
                  )
                }
                onKeepBoth={() => setDialog({ kind: "keep", pair })}
                onMerge={() => setDialog({ kind: "merge", pair })}
              >
                {pair.comments.length > 0 ? (
                  <DecisionThread comments={pair.comments} />
                ) : null}
              </DuplicatePairCard>
            ))}
          </div>
        </>
      )}

      {/* Keep both — final, but nothing is destroyed, so the confirm
          takes the neutral tone rather than madder. */}
      {dialog?.kind === "keep" && (
        <DismissDialog
          tone="neutral"
          title={t("keepBothModalTitle", { name: objectOf(dialog.pair) })}
          body={t("keepBothModalBody")}
          confirmLabel={t("keepBoth")}
          reasonPlaceholder={whyDifferent[flavourOf(dialog.pair)]}
          pending={pending}
          onCancel={() => setDialog(null)}
          onConfirm={(reason) => submitKeepBoth(dialog.pair, reason)}
        />
      )}

      {/* Merge — the direction is chosen here and nowhere else. */}
      {dialog?.kind === "merge" && (
        <PairMergeDialog
          title={t("mergeModalTitle", { name: objectOf(dialog.pair) })}
          options={[
            {
              code: dialog.pair.a.code,
              loadLine: loadLine(dialog.pair.a.descriptionCount),
            },
            {
              code: dialog.pair.b.code,
              loadLine: loadLine(dialog.pair.b.descriptionCount),
            },
          ]}
          defaultSurvivorCode={
            dialog.pair.a.descriptionCount === dialog.pair.b.descriptionCount
              ? null
              : dialog.pair.a.descriptionCount > dialog.pair.b.descriptionCount
                ? dialog.pair.a.code
                : dialog.pair.b.code
          }
          reasonPlaceholder={whySame[flavourOf(dialog.pair)]}
          pending={pending}
          onCancel={() => setDialog(null)}
          onConfirm={(survivorCode, reason) =>
            submitMerge(dialog.pair, survivorCode, reason)
          }
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ruled rows
// ---------------------------------------------------------------------------

/**
 * The ruled view: quiet rows in the proposals tab's ruled idiom. No
 * controls — the ruling is retrievable, not reversible — so each row
 * carries the object, the two codes, what was decided, and the note.
 */
function RuledPairList({
  rows,
  t,
  formatDate,
  emptyHeading,
}: {
  rows: RuledPairRow[];
  t: (key: string, opts?: Record<string, unknown>) => string;
  formatDate: (timestamp: number) => string;
  emptyHeading: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-stone-200 px-6 py-14 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-md bg-verdigris-tint">
          <CheckCheck className="h-5 w-5 text-verdigris-deep" strokeWidth={1.5} />
        </span>
        <p className="font-serif text-xl text-indigo">{emptyHeading}</p>
      </div>
    );
  }

  return (
    <>
      <p className="mt-5 text-13 nums text-stone-500">
        {t("countRuled", { count: rows.length })}
      </p>
      <div className="mt-3 flex flex-col gap-3">
        {rows.map((row) => {
          const object =
            row.names[0].trim() === row.names[1].trim()
              ? row.names[0].trim()
              : `${row.names[0]} · ${row.names[1]}`;
          return (
            <div key={row.id} className="rounded-lg border border-stone-200 px-6 pb-4 pt-5">
              <h3 className="font-serif text-2xl font-semibold leading-tight tracking-[-0.01em] text-indigo">
                {object}
              </h3>
              <p className="mt-[3px] font-mono text-11 font-medium tracking-[0.04em] text-stone-500">
                {row.codes.filter(Boolean).join(" · ")}
              </p>
              <div className="mt-4 border-t border-stone-200 pt-3 text-13 text-stone-500">
                <span className="font-semibold text-stone-700">
                  {row.ruling === "merged"
                    ? t("ruledPairMerged", { code: row.survivorCode ?? "" })
                    : t("ruledPairKeptBoth")}
                </span>
                {row.ruledAt
                  ? ` · ${t("ruledOn", { date: formatDate(row.ruledAt) })}`
                  : ""}
                {row.rulingNote ? ` — ${row.rulingNote}` : ""}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
