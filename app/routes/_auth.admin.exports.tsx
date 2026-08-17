/**
 * Exports — the surface where the workspace's records leave
 *
 * Three axes, decided in the order they are numbered: WHAT leaves, the
 * FORM it takes, and the FORMAT that carries it. The three are
 * independent by design — the same records can leave in any shape a
 * form can render — and the page's whole job is to make the pairs that
 * are NOT artifacts unofferable at the point of choice rather than
 * accepted and failed late.
 *
 * THE PAGE IS MEMBER-LEVEL; THE TIER SHAPES WHAT RENDERS. There is no
 * `requireAdmin` here, because portability is not a product tier and
 * refusing the URL would be refusing the promise. What a role changes
 * is the page itself: `matrix.ts` marks the machine-readable formats
 * ABSENT for a non-admin — not dimmed, since a role is not a choice on
 * this page and dimming it would invite someone to go looking for the
 * switch. A reader sees three descriptive standards and the PDF
 * finding aid, and no evidence that anything else exists.
 *
 * SELECTION LIVES IN THE URL. Door, branch, carried scope, handlist,
 * form, format and the authorities toggle are all query parameters, so
 * a chosen scope survives a reload, can be linked to, and — this is
 * the load-bearing part — lets the LOADER compute the real crosswalk
 * loss for the chosen form over the chosen scope. A client-side
 * selection would have had to ask the server for those counts anyway,
 * and would have had two copies of the choice to keep in step.
 *
 * TWO ENTRY PARAMETERS ARRIVE FROM ELSEWHERE. `?scope=<id>` is where
 * the search page's "Send to export" lands: it selects the carried
 * door with that stash. `?handlist=<id>` is the handlist page's Export
 * button: it selects the handlist door with that list. Neither spends
 * anything — a carried scope is consumed when a RUN starts, never on
 * arrival, so opening the page and changing your mind leaves the
 * selection where it was.
 *
 * WHAT THE LOADER PAYS FOR IS WHAT WAS ASKED. A branch, a carried
 * scope and a handlist are all bounded, so they are resolved in full
 * and their exact counts are shown. The whole workspace is not, so it
 * shows the workspace's own totals instead — and is only resolved in
 * full when a crosswalk form makes the loss counts necessary, which is
 * the one moment those ids are worth materialising.
 *
 * The retention sweep runs here, at read time, because there is no
 * cron behind the thirty-day promise — the same bargain the handlist
 * integrity read makes.
 *
 * @version v0.7.0
 */
import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Info, Search } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { BranchPicker } from "~/components/exports/branch-picker";
import type { BranchNode } from "~/components/exports/branch-picker";
import {
  ExportConfirmDialog,
  ExportRunDialog,
} from "~/components/exports/export-dialog";
import { ExportHistory } from "~/components/exports/export-history";
import {
  DIM_REASON_KEYS,
  DOOR_KEYS,
  FORMAT_KEYS,
  FORMAT_SUB_KEYS,
  FORM_KEYS,
  failureKey,
  useExportLabels,
  useScopeText,
} from "~/components/exports/export-labels";
import {
  CrosswalkLossBlock,
  useLossSummary,
} from "~/components/exports/loss-report";
import { EXPORT_FORMATS, EXPORT_FORMS } from "~/lib/export/matrix";
import type {
  ExportDoor,
  ExportForm,
  ExportFormat,
  ExportRecordClass,
} from "~/lib/export/matrix";
import type { ExportRunView } from "~/lib/export/run.server";
import type { ExportScopeDescriptor } from "~/lib/export/scopes.server";
import type { Route } from "./+types/_auth.admin.exports";

const DOORS: ExportDoor[] = ["workspace", "branch", "carried", "handlist"];

/** A handlist as the handlist door lists it. */
interface HandlistChoice {
  id: string;
  name: string;
  recordType: ExportRecordClass;
  memberCount: number;
  updatedAt: number;
}

/** An unspent stash, for the carried door's recent-searches list. */
interface RecentScope {
  id: string;
  recordType: ExportRecordClass;
  pills: string[];
  total: number;
  createdAt: number;
}

function readDoor(value: string | null): ExportDoor | null {
  return DOORS.includes(value as ExportDoor) ? (value as ExportDoor) : null;
}

function readForm(value: string | null): ExportForm | null {
  return (EXPORT_FORMS as readonly string[]).includes(value ?? "")
    ? (value as ExportForm)
    : null;
}

function readFormat(value: string | null): ExportFormat | null {
  return (EXPORT_FORMATS as readonly string[]).includes(value ?? "")
    ? (value as ExportFormat)
    : null;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql } = await import("drizzle-orm");
  const { descriptions } = await import("~/db/schema");
  const { exportMatrix } = await import("~/lib/export/matrix");
  const { countWorkspaceTotals, resolveExportScope, ExportScopeError } =
    await import("~/lib/export/scopes.server");
  const { listExportRuns, sweepExpiredExports } = await import(
    "~/lib/export/run.server"
  );
  const { listRecentCarriedScopes } = await import("~/lib/carried-scopes.server");
  const { listForUser } = await import("~/lib/handlists.server");
  const { computeCrosswalkLoss } = await import("~/lib/export/loss.server");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // The thirty-day promise, kept at read time. Bounded per call.
  await sweepExpiredExports(db, env.BUCKET, tenant);

  const sp = new URL(request.url).searchParams;
  const carriedScopeId = sp.get("scope");
  const handlistId = sp.get("handlist");
  const branchId = sp.get("branch");
  // The entry parameters imply their door: arriving from search or
  // from a handlist selects the door that stash belongs to.
  const door =
    readDoor(sp.get("door")) ??
    (carriedScopeId ? "carried" : handlistId ? "handlist" : null);
  const form = readForm(sp.get("form"));
  const format = readFormat(sp.get("format"));
  const includeAuthorities = sp.get("authorities") !== "0";

  const ownStandard = tenant.descriptiveStandard;

  // The hierarchy the branch picker paints: every node that holds
  // something, plus the roots, with exact direct-child counts. Item-
  // level descriptions are not listed — they are inside one of these
  // and come with it — so this is a few hundred rows on a workspace
  // with thousands of records.
  const containerRows = await db.all<{
    id: string;
    parent_id: string | null;
    title: string;
    reference_code: string;
    position: number;
  }>(sql`
    SELECT id, parent_id, title, reference_code, position
      FROM descriptions
     WHERE tenant_id = ${tenant.id}
       AND (parent_id IS NULL
            OR id IN (SELECT parent_id FROM descriptions
                       WHERE tenant_id = ${tenant.id} AND parent_id IS NOT NULL))
     ORDER BY position, title
  `);
  const childCounts = await db
    .select({ parentId: descriptions.parentId, n: sql<number>`count(*)` })
    .from(descriptions)
    .where(eq(descriptions.tenantId, tenant.id))
    .groupBy(descriptions.parentId)
    .all();
  const branchTree = buildBranchTree(containerRows, childCounts);

  const workspaceTotals = await countWorkspaceTotals(db, tenant);

  const handlists: HandlistChoice[] = (
    await listForUser(db, tenant, user, "all")
  )
    .filter((h) => !h.locked && h.recordType !== null && h.memberCount > 0)
    .map((h) => ({
      id: h.id,
      name: h.name,
      recordType: h.recordType as ExportRecordClass,
      memberCount: h.memberCount,
      updatedAt: h.updatedAt,
    }));

  const recentScopes: RecentScope[] = (
    await listRecentCarriedScopes(db, tenant, user)
  ).map((s) => ({
    id: s.id,
    recordType: s.recordType as ExportRecordClass,
    pills: s.pills.map((p) => p.label),
    total: s.total,
    createdAt: s.createdAt,
  }));

  // Resolve the chosen door. A crosswalk form needs the member ids to
  // count its loss, so the whole workspace — the one unbounded door —
  // is resolved only then.
  const lossy =
    form !== null && ownStandard !== null && form !== ownStandard && form !== "canonical";
  let scope: {
    recordClass: ExportRecordClass;
    counts: { records: number; entities: number; places: number; links: number };
    descriptor: ExportScopeDescriptor;
  } | null = null;
  let scopeError: string | null = null;
  let loss: Awaited<ReturnType<typeof computeCrosswalkLoss>> = null;

  if (door !== null) {
    try {
      if (door === "workspace" && !lossy) {
        scope = {
          recordClass: "records",
          counts: {
            records: workspaceTotals.records,
            entities: workspaceTotals.entities,
            places: workspaceTotals.places,
            links: 0,
          },
          descriptor: { kind: "workspace" },
        };
      } else {
        const scopeRequest =
          door === "workspace"
            ? ({ kind: "workspace" } as const)
            : door === "branch"
              ? ({ kind: "branch", descriptionId: branchId ?? "" } as const)
              : door === "carried"
                ? ({ kind: "carried", carriedScopeId: carriedScopeId ?? "" } as const)
                : ({ kind: "handlist", handlistId: handlistId ?? "" } as const);
        if (
          (door === "branch" && !branchId) ||
          (door === "carried" && !carriedScopeId) ||
          (door === "handlist" && !handlistId)
        ) {
          scope = null;
        } else {
          // Always resolved WITH the authorities, whatever the toggle
          // says: the toggle decides what leaves, and the tile has to
          // state what turning it off removes — a struck 412 that was
          // never computed would be a number nobody could stand behind.
          const resolved = await resolveExportScope(db, tenant, user, scopeRequest, {
            includeAuthorities: true,
          });
          scope = {
            recordClass: resolved.recordClass,
            counts: resolved.counts,
            descriptor: resolved.descriptor,
          };
          if (lossy && resolved.recordClass === "records" && ownStandard !== null) {
            loss = await computeCrosswalkLoss(
              db,
              tenant,
              resolved.memberIds,
              form,
              ownStandard,
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof ExportScopeError) {
        scopeError = err.code;
      } else if (err instanceof Response && err.status === 404) {
        // An owner-only carried scope that is not this person's reads
        // as a scope that never existed, which is what it is to them.
        scopeError = "scope-empty";
      } else {
        throw err;
      }
    }
  }

  const recordClass: ExportRecordClass = scope?.recordClass ?? "records";
  const matrix =
    ownStandard === null
      ? null
      : exportMatrix({ recordClass, ownStandard, isAdmin: user.isAdmin });

  const runs = await listExportRuns(db, tenant);

  return {
    isAdmin: user.isAdmin,
    ownStandard,
    workspaceTotals,
    branchTree,
    handlists,
    recentScopes,
    selection: {
      door,
      branchId,
      carriedScopeId,
      handlistId,
      form,
      format,
      includeAuthorities,
    },
    scope,
    scopeError,
    matrix,
    loss,
    runs,
  };
}

/**
 * Subtree sizes from the container rows and the exact per-parent
 * counts. A node's total is itself, plus its non-container children,
 * plus each container child's total — which is computable from the
 * container set alone, so an item-level row never has to be fetched to
 * print a number.
 */
function buildBranchTree(
  rows: {
    id: string;
    parent_id: string | null;
    title: string;
    reference_code: string;
    position: number;
  }[],
  childCounts: { parentId: string | null; n: number }[],
): BranchNode[] {
  const directChildren = new Map<string, number>();
  for (const row of childCounts) {
    if (row.parentId !== null) directChildren.set(row.parentId, Number(row.n));
  }
  const containerChildren = new Map<string, string[]>();
  const present = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    if (row.parent_id !== null && present.has(row.parent_id)) {
      const list = containerChildren.get(row.parent_id) ?? [];
      list.push(row.id);
      containerChildren.set(row.parent_id, list);
    }
  }

  const totals = new Map<string, number>();
  const beneath = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): { records: number; series: number } => {
    const cached = totals.get(id);
    if (cached !== undefined) return { records: cached, series: beneath.get(id) ?? 0 };
    if (seen.has(id)) return { records: 1, series: 0 };
    seen.add(id);

    const kids = containerChildren.get(id) ?? [];
    let records = 1 + Math.max(0, (directChildren.get(id) ?? 0) - kids.length);
    let series = kids.length;
    for (const kid of kids) {
      const sub = visit(kid, seen);
      records += sub.records;
      series += sub.series;
    }
    totals.set(id, records);
    beneath.set(id, series);
    return { records, series };
  };

  return rows.map((row) => {
    const { records, series } = visit(row.id, new Set());
    return {
      id: row.id,
      parentId: row.parent_id !== null && present.has(row.parent_id) ? row.parent_id : null,
      title: row.title,
      referenceCode: row.reference_code,
      records,
      seriesBeneath: series,
    };
  });
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export type ExportActionResult =
  | { ok: true; runId: string }
  | { ok: false; code: string };

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { cancelExportRun, getExportRun, startExportRun, ExportStandardUnsetError } =
    await import("~/lib/export/run.server");
  const { ExportScopeError } = await import("~/lib/export/scopes.server");
  const { ExportCombinationError } = await import("~/lib/export/matrix");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();
  const intent = String(formData.get("_action") ?? "");

  if (intent === "cancel") {
    const runId = String(formData.get("runId") ?? "");
    const run = await getExportRun(db, tenant, runId);
    // A run belongs to the person who started it; an admin may stop
    // any of them, because a run holding the workspace's own machinery
    // is the workspace's business.
    if (!run || (run.userId !== user.id && !user.isAdmin)) {
      return { ok: false as const, code: "not-found" };
    }
    await cancelExportRun(db, tenant, runId);
    return { ok: true as const, runId };
  }

  if (intent !== "start") {
    return { ok: false as const, code: "unexpected" };
  }

  const door = readDoor(String(formData.get("door") ?? ""));
  const form = readForm(String(formData.get("form") ?? ""));
  const format = readFormat(String(formData.get("format") ?? ""));
  const includeAuthorities = formData.get("authorities") !== "0";
  if (door === null || form === null || format === null) {
    return { ok: false as const, code: "unexpected" };
  }

  const scope =
    door === "workspace"
      ? ({ kind: "workspace" } as const)
      : door === "branch"
        ? ({ kind: "branch", descriptionId: String(formData.get("branch") ?? "") } as const)
        : door === "carried"
          ? ({
              kind: "carried",
              carriedScopeId: String(formData.get("scope") ?? ""),
            } as const)
          : ({ kind: "handlist", handlistId: String(formData.get("handlist") ?? "") } as const);

  try {
    // `startExportRun` is the whole server-side gate: it resolves the
    // scope, asserts the form/format pair against the matrix, and
    // applies the tier — the same three refusals the page rendered —
    // before a run row exists. Repeating them here would resolve the
    // scope twice to reach the same answer.
    // The finding aid's furniture speaks the exporting member's
    // language; the flat data formats ignore the locale.
    const { getLocale } = await import("~/middleware/i18next");
    const locale = getLocale(context) === "en" ? ("en" as const) : ("es" as const);
    const { runId, execute } = await startExportRun(
      { db, bucket: env.BUCKET, tenant, user, locale },
      { scope, form, format, includeAuthorities },
    );
    context.cloudflare.ctx.waitUntil(execute());
    return { ok: true as const, runId };
  } catch (err) {
    if (err instanceof ExportScopeError) return { ok: false as const, code: err.code };
    if (err instanceof ExportCombinationError) {
      return { ok: false as const, code: err.code };
    }
    if (err instanceof ExportStandardUnsetError) {
      return { ok: false as const, code: err.code };
    }
    if (err instanceof Response && err.status === 404) {
      return { ok: false as const, code: "scope-empty" };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export default function ExportsPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("exports");
  const labels = useExportLabels();
  const scopeText = useScopeText();
  const lossSummary = useLossSummary();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher<ExportActionResult>();
  const cancelFetcher = useFetcher<ExportActionResult>();

  const {
    ownStandard,
    workspaceTotals,
    branchTree,
    handlists,
    recentScopes,
    selection,
    scope,
    scopeError,
    matrix,
    loss,
    runs,
  } = loaderData;

  const [picker, setPicker] = useState<"branch" | "handlist" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [watching, setWatching] = useState<ExportRunView | null>(null);

  // A started run takes over the dialog: the confirm has been answered
  // and what the person now wants is to watch it, or to leave.
  const handledRun = useRef<string | null>(null);
  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result || !result.ok) return;
    if (handledRun.current === result.runId) return;
    setConfirming(false);
    const started = runs.find((r) => r.id === result.runId);
    // The row lands before the work starts, so it is normally here on
    // the revalidation that follows the action; until it is, this
    // effect simply waits rather than inventing a placeholder.
    if (started) {
      handledRun.current = result.runId;
      setWatching(started);
    }
  }, [fetcher.state, fetcher.data, runs]);

  const withParams = (updates: Record<string, string | null>): string => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    return query === "" ? "/admin/exports" : `/admin/exports?${query}`;
  };

  const go = (updates: Record<string, string | null>) =>
    navigate(withParams(updates), { preventScrollReset: true });

  const recordClass: ExportRecordClass = scope?.recordClass ?? "records";
  const authority = recordClass !== "records";
  const form = selection.form;
  const format = selection.format;
  const descriptor = (scope?.descriptor ?? null) as Parameters<
    typeof scopeText.summary
  >[0];

  if (ownStandard === null || matrix === null) {
    return (
      <div className="mx-auto max-w-[1280px] px-6 py-8">
        <EmptyNotice
          heading={t("standardUnsetHeading")}
          body={t("standardUnsetBody")}
        />
      </div>
    );
  }

  const ownLabel = t(FORM_KEYS[ownStandard]);
  // Before a form is chosen the third axis still has to be honest
  // about the tier, so it shows the tiles of the form that WOULD be
  // chosen first — absences and all — with every one of them inert.
  const formatTiles = matrix.formats[form ?? matrix.forms[0].form];
  const formats = form ? matrix.formats[form] : [];
  const chosenFormatLegal =
    form !== null &&
    format !== null &&
    formats.some((f) => f.format === format && f.tile.present && f.tile.legal);
  const ready = scope !== null && form !== null && chosenFormatLegal;

  const start = () => {
    fetcher.submit(
      {
        _action: "start",
        door: selection.door ?? "",
        branch: selection.branchId ?? "",
        scope: selection.carriedScopeId ?? "",
        handlist: selection.handlistId ?? "",
        form: form ?? "",
        format: format ?? "",
        authorities: selection.includeAuthorities ? "1" : "0",
      },
      { method: "post", action: "/admin/exports" },
    );
  };

  const retry = (run: ExportRunView) => {
    const d = run.descriptor;
    fetcher.submit(
      {
        _action: "start",
        door: run.scopeKind,
        branch: d?.kind === "branch" ? d.descriptionId : "",
        scope: d?.kind === "carried" ? d.carriedScopeId : "",
        handlist: d?.kind === "handlist" ? d.handlistId : "",
        form: run.form ?? "",
        format: run.format ?? "",
        authorities: run.includeAuthorities ? "1" : "0",
      },
      { method: "post", action: "/admin/exports" },
    );
  };

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-8">
      <p className="font-sans text-11 font-semibold uppercase tracking-[0.1em] text-stone-400">
        {t("eyebrow")}
      </p>
      <h1 className="mt-1 font-serif text-[1.75rem] font-semibold leading-[1.2] tracking-[-0.005em] text-indigo">
        {authority ? t("titleAuthority") : t("title")}
      </h1>
      <p className="mt-2 max-w-[64ch] font-serif text-base leading-[1.6] text-indigo-soft">
        {authority ? t("introAuthority") : t("intro")}
      </p>

      {!matrix.anyLegalCombination ? (
        <EmptyNotice heading={t("nothingHeading")} body={t("nothingBody")} />
      ) : (
        <>
          <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-[1.15fr_1fr_1fr]">
            {/* ── 1 · What ─────────────────────────────────────── */}
            <section>
              <AxisHeading label={t("axisWhat")} />

              {matrix.doors.map(({ door, tile }) => {
                if (!tile.present) return null;
                const active = selection.door === door;
                const reason =
                  tile.legal === false ? t(DIM_REASON_KEYS[tile.reason]) : null;

                return (
                  <div key={door}>
                    <Tile
                      title={t(DOOR_KEYS[door])}
                      subtitle={doorSubtitle(door)}
                      active={active}
                      reason={reason}
                      onSelect={() => {
                        if (door === "branch" && !selection.branchId) {
                          setPicker("branch");
                          return;
                        }
                        if (door === "handlist" && !selection.handlistId) {
                          setPicker("handlist");
                          return;
                        }
                        go({ door });
                      }}
                    />
                    {active && door === "branch" && renderBranchChosen()}
                    {door === "branch" && picker === "branch" && (
                      <BranchPicker
                        nodes={branchTree}
                        chosenId={selection.branchId}
                        onCancel={() => setPicker(null)}
                        onChoose={(id) => {
                          setPicker(null);
                          go({ door: "branch", branch: id });
                        }}
                      />
                    )}
                    {active && door === "carried" && renderCarried()}
                    {active && door === "handlist" && renderHandlistChosen()}
                    {door === "handlist" && picker === "handlist" && (
                      <HandlistChooser
                        handlists={handlists}
                        onCancel={() => setPicker(null)}
                        onChoose={(id) => {
                          setPicker(null);
                          go({ door: "handlist", handlist: id });
                        }}
                      />
                    )}
                  </div>
                );
              })}

              {/* The authorities toggle. Not applicable to an authority
                  scope — its members ARE the authorities. */}
              <div className="mt-3.5 rounded-md border border-stone-200 px-3.5 py-3">
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!authority && selection.includeAuthorities}
                    disabled={authority}
                    onClick={() =>
                      go({ authorities: selection.includeAuthorities ? "0" : "1" })
                    }
                    className={`mt-0.5 h-5 w-9 flex-none rounded-full transition-colors disabled:opacity-40 ${
                      !authority && selection.includeAuthorities
                        ? "bg-verdigris"
                        : "bg-stone-300"
                    }`}
                  >
                    <span
                      className={`block h-4 w-4 rounded-full bg-white transition-transform ${
                        !authority && selection.includeAuthorities
                          ? "translate-x-4"
                          : "translate-x-0.5"
                      }`}
                    />
                  </button>
                  <span className="min-w-0">
                    <b className="block text-sm font-semibold leading-snug text-indigo">
                      {t("toggleTitle")}
                    </b>
                    <small className="mt-0.5 block text-13 leading-normal text-stone-500">
                      {authority
                        ? t("toggleNotApplicable")
                        : selection.includeAuthorities
                          ? t("toggleSub")
                          : t("toggleOff")}
                    </small>
                  </span>
                </div>
                {scope !== null && !authority && (
                  <p className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 pl-12 font-mono text-11 nums">
                    <span className="text-indigo">
                      {labels.count("records", scope.counts.records)}
                    </span>
                    {/* Removed counts are STRUCK, not hidden: a number
                        that vanishes leaves a cataloguer unsure whether
                        the toggle worked. */}
                    <span
                      className={
                        selection.includeAuthorities
                          ? "text-indigo"
                          : "text-stone-400 line-through"
                      }
                    >
                      {labels.count("entities", scope.counts.entities)}
                    </span>
                    <span
                      className={
                        selection.includeAuthorities
                          ? "text-indigo"
                          : "text-stone-400 line-through"
                      }
                    >
                      {labels.count("places", scope.counts.places)}
                    </span>
                  </p>
                )}
              </div>

              {scopeError !== null && (
                <p className="mt-3 flex items-start gap-2 text-13 leading-normal text-madder-deep">
                  <Info className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                  {t(failureKey(scopeError))}
                </p>
              )}
            </section>

            {/* ── 2 · Form ─────────────────────────────────────── */}
            <section>
              <AxisHeading label={t("axisForm")} />
              {matrix.forms.map(({ form: candidate, tile, lossless }) => {
                if (!tile.present) return null;
                return (
                  <Tile
                    key={candidate}
                    title={t(FORM_KEYS[candidate])}
                    subtitle={formSubtitle(candidate, lossless)}
                    active={form === candidate}
                    reason={
                      tile.legal === false ? t(DIM_REASON_KEYS[tile.reason]) : null
                    }
                    onSelect={() => go({ form: candidate })}
                  />
                );
              })}

              {loss !== null && form !== null && (
                <CrosswalkLossBlock
                  loss={loss}
                  formLabel={t(FORM_KEYS[form])}
                  ownLabel={ownLabel}
                  onUseOwn={() => go({ form: ownStandard })}
                />
              )}

              {authority && (
                <aside className="mt-3.5 rounded-md border border-dashed border-stone-300 px-3.5 py-3">
                  <p className="font-sans text-11 font-semibold uppercase tracking-[0.08em] text-stone-400">
                    {t("eacLabel")}
                  </p>
                  <b className="mt-1 block text-sm font-semibold text-stone-600">
                    {t("eacTitle")}
                  </b>
                  <small className="mt-0.5 block text-13 leading-normal text-stone-500">
                    {t("eacBody")}
                  </small>
                </aside>
              )}
            </section>

            {/* ── 3 · Format ───────────────────────────────────── */}
            <section>
              <AxisHeading label={t("axisFormat")} />
              {formatTiles.map(({ format: candidate, tile }) => {
                if (!tile.present) return null;
                return (
                  <Tile
                    key={candidate}
                    title={t(FORMAT_KEYS[candidate])}
                    subtitle={
                      candidate === "csv" && form === "canonical"
                        ? t("formatCsvSubCanonical")
                        : t(FORMAT_SUB_KEYS[candidate])
                    }
                    active={format === candidate}
                    disabled={form === null}
                    reason={
                      tile.legal === false ? t(DIM_REASON_KEYS[tile.reason]) : null
                    }
                    onSelect={() => go({ format: candidate })}
                  />
                );
              })}
            </section>
          </div>

          {/* ── The confirm bar ────────────────────────────────── */}
          <div className="mt-8 flex flex-col gap-3 border-t border-stone-200 pt-4 md:flex-row md:items-center md:gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-13 leading-normal nums text-stone-600">
                {ready && scope !== null && form !== null && format !== null
                  ? t("barSummary", {
                      scope: scopeText.summary(descriptor),
                      form: t(FORM_KEYS[form]),
                      format: t(FORMAT_KEYS[format]),
                      counts: labels.counts(recordClass, scope.counts, {
                        includeAuthorities: selection.includeAuthorities,
                        separator: ", ",
                      }),
                    })
                  : t("barNothingChosen")}
              </p>
              <p className="mt-0.5 text-11 text-stone-400">
                {authority ? t("barRecordedAuthority") : t("barRecorded")}
              </p>
            </div>
            <button
              type="button"
              disabled={!ready || fetcher.state !== "idle"}
              onClick={() => setConfirming(true)}
              className="inline-flex h-[42px] flex-none items-center justify-center rounded-lg bg-verdigris px-5 font-sans text-15 font-semibold text-white hover:bg-verdigris-deep disabled:cursor-not-allowed disabled:opacity-30"
            >
              {t("exportAction")}
            </button>
          </div>

          {fetcher.data && !fetcher.data.ok && (
            <p className="mt-3 flex items-start gap-2 text-13 leading-normal text-madder-deep">
              <Info className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
              {t(failureKey(fetcher.data.code))}
            </p>
          )}
        </>
      )}

      <ExportHistory
        runs={runs}
        onCancel={(runId) =>
          cancelFetcher.submit(
            { _action: "cancel", runId },
            { method: "post", action: "/admin/exports" },
          )
        }
        onRetry={retry}
      />

      {confirming && scope !== null && form !== null && format !== null && (
        <ExportConfirmDialog
          recordClass={recordClass}
          counts={scope.counts}
          includeAuthorities={selection.includeAuthorities}
          scopeSummary={scopeText.summary(descriptor)}
          scopeNote={scopeText.note(descriptor)}
          form={form}
          format={format}
          ownStandardLabel={ownLabel}
          formNoteKind={
            form === ownStandard
              ? "own"
              : form === "canonical"
                ? "canonical"
                : "crosswalk"
          }
          lossLine={loss !== null ? lossSummary(loss) : null}
          pending={fetcher.state !== "idle"}
          onCancel={() => setConfirming(false)}
          onConfirm={start}
        />
      )}

      {watching !== null && (
        <ExportRunDialog
          run={watching}
          scopeSummary={scopeText.summary(watching.descriptor)}
          onClose={() => setWatching(null)}
          onCancelRun={(runId) =>
            cancelFetcher.submit(
              { _action: "cancel", runId },
              { method: "post", action: "/admin/exports" },
            )
          }
        />
      )}
    </div>
  );

  // ── Door bodies ───────────────────────────────────────────────

  function doorSubtitle(door: ExportDoor): string {
    if (door === "workspace") {
      return labels.counts(
        "records",
        { ...workspaceTotals, links: 0 },
        { includeAuthorities: true },
      );
    }
    if (door === "branch") return t("doorBranchSub");
    if (door === "carried") {
      return recentScopes.length === 0 && !selection.carriedScopeId
        ? t("doorCarriedSubEmpty")
        : t("doorCarriedSub");
    }
    return authority ? t("doorHandlistSubAuthority") : t("doorHandlistSub");
  }

  function formSubtitle(candidate: ExportForm, lossless: boolean): string {
    if (candidate === "canonical") return t("formCanonicalSub");
    if (candidate === "dc") {
      return authority ? t("formDcSubAuthority") : t("formDcSub");
    }
    return lossless ? t("formOwnSub") : t("formCrosswalkSub");
  }

  function renderBranchChosen() {
    const node = branchTree.find((n) => n.id === selection.branchId);
    if (!node) return null;
    return (
      <div className="ml-6 mt-2 rounded-sm border border-stone-200 bg-verdigris-wash px-3 py-2">
        <p className="font-mono text-11 nums text-stone-500">
          {node.referenceCode}
        </p>
        <p className="mt-px text-sm font-semibold text-indigo">{node.title}</p>
        <div className="mt-1 flex items-center justify-between gap-3">
          <small className="font-mono text-11 nums text-stone-500">
            {node.seriesBeneath > 0
              ? t("branchSummary", {
                  records: labels.count("records", node.records),
                  series: labels.count("series", node.seriesBeneath),
                })
              : t("branchSummaryFlat", {
                  records: labels.count("records", node.records),
                })}
          </small>
          <button
            type="button"
            onClick={() => setPicker("branch")}
            className="text-xs font-semibold text-verdigris-deep hover:underline"
          >
            {t("branchChange")}
          </button>
        </div>
      </div>
    );
  }

  function renderCarried() {
    if (!selection.carriedScopeId || scope === null) {
      return (
        <div className="ml-6 mt-2 rounded-sm border border-stone-200 px-3 py-3">
          <b className="block text-sm font-semibold text-indigo">
            {t("carriedEmptyHeading")}
          </b>
          <small className="mt-0.5 block text-13 leading-normal text-stone-500">
            {t("carriedEmptyBody")}
          </small>
          {recentScopes.length > 0 && (
            <>
              <p className="mt-3 font-sans text-11 font-semibold uppercase tracking-[0.08em] text-stone-400">
                {t("carriedRecentLabel")}
              </p>
              <ul className="mt-1">
                {recentScopes.map((recent) => (
                  <li key={recent.id}>
                    <Link
                      to={withParams({ door: "carried", scope: recent.id })}
                      className="flex items-center gap-3 rounded-sm px-1 py-1.5 hover:bg-stone-50"
                    >
                      <span className="min-w-0 flex-1 truncate text-13 text-stone-700">
                        {recent.pills.length > 0
                          ? recent.pills.join(" · ")
                          : t("scopeSelection")}
                      </span>
                      <span className="flex-none font-mono text-11 nums text-stone-400">
                        {labels.number(recent.total)}
                      </span>
                      <span className="flex-none font-mono text-11 nums text-stone-400">
                        {new Date(recent.createdAt).toISOString().slice(5, 10)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
          <Link
            to="/search"
            className="mt-3 inline-flex items-center gap-1.5 text-13 font-semibold text-verdigris-deep hover:underline"
          >
            <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
            {t("carriedOpenSearch")}
          </Link>
        </div>
      );
    }

    const carried = descriptor?.kind === "carried" ? descriptor : null;
    if (carried === null) return null;
    const pruned = carried.unticked > 0;

    return (
      <div className="ml-6 mt-2 rounded-sm border border-stone-200 bg-verdigris-wash px-3 py-2">
        <p className="font-serif text-sm text-indigo">
          {carried.pills.length > 0
            ? carried.pills.join(" · ")
            : t(
                recordClass === "records"
                  ? "carriedTickedRecords"
                  : recordClass === "entities"
                    ? "carriedTickedEntities"
                    : "carriedTickedPlaces",
                {
                  records: labels.count("records", carried.willExport),
                  entities: labels.count("entities", carried.willExport),
                  places: labels.count("places", carried.willExport),
                },
              )}
        </p>
        <div className="mt-1 flex items-center justify-between gap-3">
          <small className="font-mono text-11 nums text-stone-500">
            {carried.pills.length > 0
              ? t("carriedRunStamp", {
                  stamp: new Date(carried.carriedAt)
                    .toISOString()
                    .slice(0, 16)
                    .replace("T", " "),
                })
              : carried.origin
                ? // Ticked on a browse list: name where, and say plainly
                  // that no question was asked.
                  `${carried.origin} · ${t("carriedNoQuery")}`
                : t("carriedNoQuery")}
          </small>
          <button
            type="button"
            onClick={() => go({ scope: null, door: "carried" })}
            className="text-xs font-semibold text-verdigris-deep hover:underline"
          >
            {t("carriedChange")}
          </button>
        </div>
        {pruned ? (
          <p className="mt-2 flex flex-wrap items-baseline gap-x-2.5 font-mono text-11 nums">
            <span className="text-stone-500">
              {t(
                recordClass === "records"
                  ? "carriedFoundRecords"
                  : recordClass === "entities"
                    ? "carriedFoundEntities"
                    : "carriedFoundPlaces",
                {
                  records: labels.count("records", carried.found),
                  entities: labels.count("entities", carried.found),
                  places: labels.count("places", carried.found),
                },
              )}
            </span>
            <span className="text-stone-500">
              {t("carriedUnticked", { formatted: labels.number(carried.unticked) })}
            </span>
            <span className="font-semibold text-indigo">
              {t("carriedWillExport", {
                items: labels.primary(recordClass, carried.willExport),
              })}
            </span>
          </p>
        ) : carried.pills.length > 0 ? (
          <p className="mt-2 font-mono text-11 nums text-stone-500">
            {t("carriedAllMatches", {
              items: labels.primary(recordClass, carried.willExport),
            })}
          </p>
        ) : null}
        {/* "all matches included" answers a question nobody asked when
            the set was ticked off a list: there are no matches to be
            all of, and the count is already in the line above. */}
        {carried.pills.length > 0 ? (
          <p className="mt-2 text-11 leading-normal text-stone-500">
            {t("carriedRerun", {
              time: new Date(carried.carriedAt).toISOString().slice(11, 16),
            })}
          </p>
        ) : (
          <p className="mt-2 text-11 leading-normal text-stone-500">
            {t("carriedNotSaved")}
          </p>
        )}
      </div>
    );
  }

  function renderHandlistChosen() {
    const chosen = handlists.find((h) => h.id === selection.handlistId);
    if (!chosen) return null;
    const metaKey =
      chosen.recordType === "entities"
        ? "handlistMetaEntities"
        : chosen.recordType === "places"
          ? "handlistMetaPlaces"
          : "handlistMeta";
    return (
      <div className="ml-6 mt-2 rounded-sm border border-stone-200 bg-verdigris-wash px-3 py-2">
        <p className="text-sm font-semibold text-indigo">{chosen.name}</p>
        <div className="mt-1 flex items-center justify-between gap-3">
          <small className="font-mono text-11 nums text-stone-500">
            {t(metaKey, {
              records: labels.count("records", chosen.memberCount),
              entities: labels.count("entities", chosen.memberCount),
              places: labels.count("places", chosen.memberCount),
              date: new Date(chosen.updatedAt).toISOString().slice(0, 10),
            })}
          </small>
          <button
            type="button"
            onClick={() => setPicker("handlist")}
            className="text-xs font-semibold text-verdigris-deep hover:underline"
          >
            {t("handlistChange")}
          </button>
        </div>
        <p className="mt-2 text-11 leading-normal text-stone-500">
          {authority
            ? t(
                chosen.recordType === "entities"
                  ? "handlistTypedEntities"
                  : "handlistTypedPlaces",
              )
            : t("handlistOrderNote")}
        </p>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function AxisHeading({ label }: { label: string }) {
  return (
    <p className="mb-2.5 flex items-center gap-2.5 font-sans text-11 font-semibold uppercase tracking-[0.1em] text-stone-400">
      {label}
      <i className="h-px flex-1 bg-stone-200" />
    </p>
  );
}

/**
 * One choice on an axis. A dimmed tile keeps its reason at every
 * width: the legality text is the point of the tile, not a decoration
 * to drop for space, and it is never truncated with an ellipsis.
 */
function Tile({
  title,
  subtitle,
  active,
  reason,
  disabled,
  onSelect,
}: {
  title: string;
  subtitle: string;
  active: boolean;
  reason: string | null;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const off = reason !== null || disabled === true;
  return (
    <button
      type="button"
      disabled={off}
      aria-pressed={active}
      onClick={onSelect}
      className={`mb-2 flex w-full items-start gap-2.5 rounded-md border px-3.5 py-3 text-left transition-colors ${
        active
          ? "border-indigo bg-indigo-wash"
          : off
            ? "cursor-not-allowed border-stone-200"
            : "border-stone-200 hover:border-stone-400"
      }`}
    >
      <span
        className={`mt-0.5 h-[15px] w-[15px] flex-none rounded-full bg-white ${
          active ? "border-[4.5px] border-indigo" : "border-[1.5px] border-stone-300"
        } ${reason !== null ? "opacity-30" : ""}`}
      />
      <span className="min-w-0 flex-1">
        <b
          className={`block text-15 font-semibold leading-tight text-indigo ${
            reason !== null ? "opacity-30" : ""
          }`}
        >
          {title}
        </b>
        <small className="mt-0.5 block text-13 leading-normal text-stone-500">
          {reason ?? subtitle}
        </small>
      </span>
    </button>
  );
}

/** The type-matched list the handlist door opens. */
function HandlistChooser({
  handlists,
  onChoose,
  onCancel,
}: {
  handlists: HandlistChoice[];
  onChoose: (id: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("exports");
  const labels = useExportLabels();

  return (
    <div
      className="mt-2 rounded-md border border-stone-200 bg-white"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-3 py-2">
        <p className="font-sans text-11 font-semibold uppercase tracking-[0.08em] text-stone-400">
          {t("handlistChoose")}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-stone-200 px-1.5 py-0.5 font-mono text-11 uppercase text-stone-400 hover:text-stone-600"
        >
          {t("branchEscHint")}
        </button>
      </div>
      {handlists.length === 0 ? (
        <div className="px-3 py-6 text-center">
          <b className="block font-serif text-15 font-semibold text-indigo">
            {t("handlistEmptyHeading")}
          </b>
          <small className="mt-1 block text-13 leading-normal text-stone-500">
            {t("handlistEmptyBody")}
          </small>
          <Link
            to="/handlists"
            className="mt-2 inline-block text-13 font-semibold text-verdigris-deep hover:underline"
          >
            {t("handlistOpen")}
          </Link>
        </div>
      ) : (
        <ul className="max-h-[280px] overflow-y-auto px-2 py-2">
          {handlists.map((handlist) => (
            <li key={handlist.id}>
              <button
                type="button"
                onClick={() => onChoose(handlist.id)}
                className="flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left hover:bg-stone-50"
              >
                <span className="min-w-0 flex-1 truncate text-13 text-stone-700">
                  {handlist.name}
                </span>
                <span className="flex-none font-mono text-11 nums text-stone-400">
                  {labels.primary(handlist.recordType, handlist.memberCount)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyNotice({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="mt-8 rounded-md border border-stone-200 px-5 py-10 text-center">
      <b className="block font-serif text-lg font-semibold text-indigo">
        {heading}
      </b>
      <small className="mx-auto mt-1.5 block max-w-[52ch] text-sm leading-relaxed text-stone-500">
        {body}
      </small>
    </div>
  );
}

/* @version v0.7.0 */
