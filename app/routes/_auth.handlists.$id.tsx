/**
 * A handlist's own page
 *
 * Where a handlist is read, ordered, curated and exported. The header
 * names it in serif because a person wrote that name, and the meta
 * line beside it is mono because everything in it is a number or a
 * stamp: how many it holds, how many would actually leave, how many
 * are waiting on a decision, and when it last moved.
 *
 * THE COUNT MAY NOT LIE, so this page prints two of them. `total` is
 * what the handlist holds after merge collapses, tombstones included;
 * `exportable` is what an export would actually take. They differ
 * whenever the workspace has moved under the handlist, and the
 * difference is the whole reason the drift banner exists — a handlist
 * that quietly diverged from the catalogue would export something
 * other than what it says it holds.
 *
 * THREE ROWS THAT ARE NOT ORDINARY. A member that followed a merge
 * carries a note and an Acknowledge, because following keeps the
 * handlist useful and the note keeps it honest. A member that was
 * SPLIT cannot be chosen for — the row offers both successors, keep
 * both, or remove, and until one is picked the row is unresolved. A
 * member deleted from the workspace keeps a tombstone: struck through,
 * visible, and left out of the export count rather than dropped, so
 * the number a person remembers does not silently change.
 *
 * EXPORT WAITS ON THE REVIEW. While any row is unresolved the export
 * action is disabled and says why. The alternative — exporting anyway
 * and mentioning the omission afterwards — is the failure the whole
 * integrity read exists to prevent. The action links at
 * `/admin/exports?handlist=<id>`, a target that arrives in a later
 * phase; the link is real now rather than pointed at a stub.
 *
 * REORDERING SENDS THE WHOLE ORDER. A drag rearranges the rows on the
 * page, but what is submitted is every member id in its new sequence,
 * because `reorderMembers` takes an explicit list and would otherwise
 * push the members this page cannot see to the end of the handlist.
 *
 * SEARCHING THE SET LEAVES THE PAGE. The field above the members is a
 * plain GET to `/search` carrying `handlist=<id>`, so a question asked
 * here is answered on the search surface with the handlist pill already
 * set. Running it privately here would mean a second implementation of
 * the tabs, the facets and the selection bar — one facet, two
 * entrances, one state.
 *
 * NO ACCESS IS RENDERED, NOT THROWN. An entities- or places-typed
 * handlist takes the admin gate its module takes, and someone who lost
 * that flag after a share landed gets the refusal in place, carrying
 * its reason — the same treatment the index gives the row they clicked
 * to get here. An absent or foreign handlist stays a 404.
 *
 * @version v0.7.0
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, redirect, useFetcher, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import {
  Download,
  Eye,
  GitMerge,
  GripVertical,
  Info,
  Search,
  ShieldAlert,
  Split,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { Pager } from "~/components/ui/pager";
import { useFormatters } from "~/lib/use-formatters";
import { tenantContext, userContext } from "../context";
import { DeleteHandlistDialog } from "~/components/handlists/delete-handlist-dialog";
import { RenameHandlistDialog } from "~/components/handlists/rename-handlist-dialog";
import { ShareHandlistDialog } from "~/components/handlists/share-handlist-dialog";
import {
  HELD_KEYS,
  SEARCH_WITHIN_KEYS,
  WILL_EXPORT_KEYS,
} from "~/components/handlists/handlist-labels";
import type {
  HandlistLockReason,
  HandlistMemberRow,
  HandlistShareRole,
} from "~/lib/handlists.server";
import type { Route } from "./+types/_auth.handlists.$id";

/** Rows per page — the same 25 the search results use. */
const PAGE_SIZE = 25;

/** Machine reason → the sentence the reader gets. */
const REASON_KEYS: Record<HandlistLockReason, string> = {
  "authorities-admin-only": "reasonAuthoritiesAdminOnly",
};

/** Every refusal this page phrases rather than throws. */
type ErrorCode =
  | "duplicate-name"
  | "name-required"
  | "ineligible-share"
  | "ceiling"
  | "forbidden"
  | "not-found"
  | "generic";

type ActionResult =
  | { ok: true }
  | { ok: false; error: ErrorCode; name?: string };

/** Mono stamps stay ISO in both locales — they are machine facts. */
function isoDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const {
    HANDLIST_MAX_MEMBERS,
    HANDLIST_WARN_MEMBERS,
    getWithMembers,
    listShareCandidates,
  } = await import("~/lib/handlists.server");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  let detail;
  try {
    detail = await getWithMembers(db, tenant, user, params.id);
  } catch (err) {
    // The admin gate on an authority-typed handlist is a refusal this
    // person can understand and act on — they were shared it and then
    // demoted — so it renders in place with its reason. A 404 is the
    // visibility rule declining to confirm the row exists, and stays
    // a 404.
    if (err instanceof Response && err.status === 403) {
      return {
        locked: true as const,
        reason: "authorities-admin-only" as HandlistLockReason,
      };
    }
    throw err;
  }

  const page = Math.max(
    1,
    parseInt(new URL(request.url).searchParams.get("page") || "1", 10) || 1,
  );
  const offset = (page - 1) * PAGE_SIZE;

  // Only the owner may share, and `listShareCandidates` enforces that
  // itself — the dialog is loaded with the page so opening it costs no
  // round trip.
  const candidates = detail.canManage
    ? await listShareCandidates(db, tenant, user, params.id)
    : [];

  return {
    locked: false as const,
    handlist: {
      id: detail.id,
      name: detail.name,
      description: detail.description,
      recordType: detail.recordType,
      workspaceVisible: detail.workspaceVisible,
      ownerName: detail.ownerName,
      ownerEmail: detail.ownerEmail,
      role: detail.role,
      canEdit: detail.canEdit,
      canManage: detail.canManage,
      total: detail.total,
      exportable: detail.exportable,
      needsReviewCount: detail.needsReviewCount,
      missingCount: detail.missingCount,
      needsReview: detail.needsReview,
      shareCount: detail.shares.length,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    },
    members: detail.members.slice(offset, offset + PAGE_SIZE),
    // The whole sequence, so a drag on one page can submit an order
    // that does not disturb the pages it cannot see.
    allMemberIds: detail.members.map((m) => m.memberId),
    candidates,
    page,
    pageSize: PAGE_SIZE,
    // The ceiling travels in the payload rather than being repeated
    // here: the number the refusal names has to be the number the
    // server enforces.
    maxMembers: HANDLIST_MAX_MEMBERS,
    warnMembers: HANDLIST_WARN_MEMBERS,
    // Where the first unresolved row is, so the banner's Review can
    // reach it even when it sits on a page nobody is looking at.
    firstReviewIndex: detail.members.findIndex((m) => m.needsReview),
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/** Turn a thrown refusal into the code this page phrases. */
function codeFor(err: Response, intent: string): ErrorCode {
  if (err.status === 403) return "forbidden";
  if (err.status === 404) return "not-found";
  if (err.status === 409) return "duplicate-name";
  if (err.status === 400) {
    if (intent === "rename") return "name-required";
    if (intent === "share") return "ineligible-share";
    return "ceiling";
  }
  return "generic";
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const handlists = await import("~/lib/handlists.server");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  const formData = await request.formData();
  const intent = (formData.get("_action") as string) || "";
  const id = params.id;
  const name = ((formData.get("name") as string) || "").trim();

  try {
    switch (intent) {
      case "rename": {
        if (name === "") {
          return { ok: false as const, error: "name-required" as const };
        }
        await handlists.renameHandlist(db, tenant, user, id, { name });
        break;
      }
      case "delete": {
        await handlists.deleteHandlist(db, tenant, user, id);
        // The page it was deleted from no longer exists.
        return redirect("/handlists");
      }
      case "share": {
        const role = formData.get("role") as HandlistShareRole;
        await handlists.shareHandlist(db, tenant, user, id, {
          userId: (formData.get("userId") as string) || "",
          role: role === "editor" ? "editor" : "viewer",
        });
        break;
      }
      case "unshare": {
        await handlists.unshareHandlist(
          db,
          tenant,
          user,
          id,
          (formData.get("userId") as string) || "",
        );
        break;
      }
      case "visibility": {
        await handlists.setWorkspaceVisible(
          db,
          tenant,
          user,
          id,
          formData.get("visible") === "1",
        );
        break;
      }
      case "remove-member": {
        await handlists.removeMember(
          db,
          tenant,
          user,
          id,
          (formData.get("memberId") as string) || "",
        );
        break;
      }
      case "reorder": {
        const raw = (formData.get("order") as string) || "[]";
        let order: string[] = [];
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            order = parsed.filter((v): v is string => typeof v === "string");
          }
        } catch {
          order = [];
        }
        await handlists.reorderMembers(db, tenant, user, id, order);
        break;
      }
      case "resolve": {
        const memberId = (formData.get("memberId") as string) || "";
        const choice = (formData.get("choice") as string) || "";
        const successorId = (formData.get("successorId") as string) || "";
        const resolution =
          choice === "keep-both"
            ? ({ memberId, action: "keep-both" } as const)
            : choice === "keep"
              ? ({ memberId, action: "keep", successorId } as const)
              : choice === "remove"
                ? ({ memberId, action: "remove" } as const)
                : ({ memberId, action: "acknowledge" } as const);
        await handlists.resolveReview(db, tenant, user, id, resolution);
        break;
      }
      default:
        return { ok: false as const, error: "generic" as const };
    }
  } catch (err) {
    if (err instanceof Response) {
      return { ok: false as const, error: codeFor(err, intent), name };
    }
    throw err;
  }

  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HandlistDetailPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("handlists");

  if (loaderData.locked) {
    return (
      <div className="mx-auto max-w-[1280px] px-6 py-8">
        <Link
          to="/handlists"
          className="font-sans text-11 font-semibold uppercase tracking-[0.1em] text-stone-400 hover:text-indigo"
        >
          {t("title")}
        </Link>
        <div className="mt-12 flex justify-center">
          <div className="mx-auto max-w-md rounded-xl bg-white p-8 text-center shadow-sm ring-1 ring-stone-100">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-indigo-tint">
              <ShieldAlert className="h-8 w-8 text-indigo" strokeWidth={1.5} />
            </div>
            <h1 className="mt-4 font-serif text-lg font-semibold text-indigo">
              {t("noAccessTitle")}
            </h1>
            <p className="mx-auto mt-2 max-w-measure font-serif text-15 text-stone-500">
              {t(REASON_KEYS[loaderData.reason])}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return <HandlistDetail data={loaderData} />;
}

type LoadedDetail = Extract<
  Awaited<ReturnType<typeof loader>>,
  { locked: false }
>;

function HandlistDetail({ data }: { data: LoadedDetail }) {
  const { t } = useTranslation("handlists");
  const { handlist, members, allMemberIds, candidates, page, pageSize } = data;
  const { formatNumber } = useFormatters();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher<ActionResult>();
  const [dialog, setDialog] = useState<"rename" | "share" | "delete" | null>(
    null,
  );
  // The page's rows, held locally so a drag can rearrange them before
  // the server hears about it.
  const [order, setOrder] = useState<HandlistMemberRow[]>(members);
  const [dragging, setDragging] = useState<number | null>(null);

  useEffect(() => setOrder(members), [members]);

  const pending = fetcher.state !== "idle";
  const result = fetcher.data;

  // Rename and delete close on success; share stays open, because
  // sharing is a series of small changes rather than one submission.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && dialog !== "share") {
      setDialog(null);
    }
  }, [fetcher.state, fetcher.data, dialog]);

  const errorMessage =
    result && !result.ok
      ? result.error === "duplicate-name"
        ? t("errorDuplicateName", { name: result.name ?? handlist.name })
        : result.error === "name-required"
          ? t("errorNameRequired")
          : result.error === "ineligible-share"
            ? t("errorIneligibleShare")
            : result.error === "ceiling"
              ? t("errorCeiling", { max: formatNumber(data.maxMembers) })
              : result.error === "forbidden"
                ? t("errorForbidden")
                : result.error === "not-found"
                  ? t("errorNotFound")
                  : t("errorGeneric")
      : undefined;

  const submit = (values: Record<string, string>) =>
    fetcher.submit(values, {
      method: "post",
      action: `/handlists/${handlist.id}`,
    });

  const held = handlist.recordType
    ? t(HELD_KEYS[handlist.recordType], { count: handlist.total })
    : t("metaHeldEmpty");
  const excluded = handlist.total - handlist.exportable;
  const drifted = handlist.needsReviewCount + handlist.missingCount;
  const exportHref = `/admin/exports?handlist=${handlist.id}`;
  /** "Search these 42 records…" — the set the field is about to ask. */
  const searchWithinLabel = handlist.recordType
    ? t(SEARCH_WITHIN_KEYS[handlist.recordType], { count: handlist.total })
    : "";

  // Move a row within the page, then submit the WHOLE sequence: the
  // pages this one cannot see keep their places.
  const moveRow = (from: number, to: number) => {
    if (from === to || to < 0 || to >= order.length) return;
    const next = [...order];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    setOrder(next);

    const offset = (page - 1) * pageSize;
    const pageIds = next.map((m) => m.memberId);
    const full = [
      ...allMemberIds.slice(0, offset),
      ...pageIds,
      ...allMemberIds.slice(offset + pageIds.length),
    ];
    submit({ _action: "reorder", order: JSON.stringify(full) });
  };

  const pagerHint =
    excluded > 0
      ? t("footExportHint", {
          exportable: handlist.exportable,
          excluded,
        })
      : handlist.canEdit
        ? t("footDragHint")
        : undefined;

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-8">
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <Link
            to="/handlists"
            className="font-sans text-11 font-semibold uppercase tracking-[0.1em] text-stone-400 hover:text-indigo"
          >
            {t("title")}
          </Link>
          <h1 className="mt-1 font-serif text-2xl font-semibold leading-tight text-indigo">
            {handlist.name}
          </h1>
          <p className="mt-1.5 flex flex-wrap gap-x-3.5 font-mono text-xs nums text-stone-500">
            <span>{held}</span>
            {excluded > 0 && handlist.recordType && (
              <span>
                {t(WILL_EXPORT_KEYS[handlist.recordType], {
                  count: handlist.exportable,
                })}
              </span>
            )}
            {handlist.needsReviewCount > 0 && (
              <span className="font-medium text-saffron-fg">
                {t("metaNeedsReview", { count: handlist.needsReviewCount })}
              </span>
            )}
            {handlist.missingCount > 0 && (
              <span className="font-medium text-saffron-fg">
                {t("metaMissing", { count: handlist.missingCount })}
              </span>
            )}
            <span>
              {handlist.role === "owner"
                ? t("ownYours")
                : t("sharedBy", {
                    name: handlist.ownerName ?? handlist.ownerEmail,
                  })}
            </span>
            <span>{t("savedAt", { date: isoDay(handlist.createdAt) })}</span>
            {isoDay(handlist.updatedAt) !== isoDay(handlist.createdAt) && (
              <span>
                {t("updatedAt", { date: isoDay(handlist.updatedAt) })}
              </span>
            )}
          </p>
          {handlist.description && (
            <p className="mt-1.5 max-w-[64ch] font-serif text-15 text-stone-600">
              {handlist.description}
            </p>
          )}
        </div>

        <div className="mt-1 flex flex-none gap-2">
          {handlist.canManage ? (
            <>
              <HeaderButton
                label={t("share")}
                icon={<Users className="h-3.5 w-3.5" strokeWidth={1.75} />}
                onClick={() => setDialog("share")}
              />
              <HeaderButton
                label={t("rename")}
                onClick={() => setDialog("rename")}
              />
              <HeaderButton
                label={t("delete")}
                icon={<Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />}
                onClick={() => setDialog("delete")}
              />
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-tint px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.06em] text-indigo">
              <Eye className="h-2.5 w-2.5" strokeWidth={1.75} />
              {handlist.canEdit ? t("roleCanEdit") : t("roleViewOnly")}
            </span>
          )}

          {/* Export is offered to everyone who can open the handlist —
              the format tier is settled on the export page, by role.
              It waits, though, on any row that has not been reviewed. */}
          {handlist.needsReview ? (
            <span
              aria-disabled="true"
              title={t("exportBlockedWhy")}
              className="inline-flex h-9 cursor-not-allowed items-center gap-1.5 rounded-lg bg-indigo px-3.5 text-13 font-semibold text-parchment opacity-30"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
              {t("exportHandlist")}
            </span>
          ) : (
            <Link
              to={exportHref}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-indigo px-3.5 text-13 font-semibold text-parchment hover:bg-indigo-deep"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
              {t("exportHandlist")}
            </Link>
          )}
        </div>
      </div>

      {drifted > 0 && (
        <div className="mt-4 flex items-start gap-2.5 rounded-md border border-saffron bg-saffron-tint px-3.5 py-3">
          <TriangleAlert
            className="mt-px h-4 w-4 flex-none text-saffron-fg"
            strokeWidth={1.75}
          />
          <p className="flex-1 text-13 leading-relaxed text-stone-700">
            <b className="font-semibold text-saffron-fg">
              {t("driftLead", { count: drifted })}
            </b>{" "}
            {t("driftExport", {
              count: excluded,
              exportable: handlist.exportable,
              total: handlist.total,
            })}
          </p>
          {handlist.needsReviewCount > 0 && data.firstReviewIndex >= 0 && (
            <Link
              to={`?page=${Math.floor(data.firstReviewIndex / pageSize) + 1}`}
              className="inline-flex h-7 flex-none items-center rounded-lg border border-saffron bg-white px-3 text-xs font-semibold text-saffron-fg hover:bg-saffron-tint"
            >
              {t("driftReview", { count: handlist.needsReviewCount })}
            </Link>
          )}
        </div>
      )}

      {handlist.needsReview && (
        <div className="mt-2.5 flex items-start gap-2 rounded-md border border-stone-200 bg-stone-50 px-3.5 py-3">
          <Info className="mt-0.5 h-3.5 w-3.5 flex-none text-stone-400" strokeWidth={1.75} />
          <p className="text-13 leading-relaxed text-stone-600">
            {t("exportBlockedWhy")}
          </p>
        </div>
      )}

      {handlist.total > data.warnMembers && (
        <div className="mt-2.5 flex items-start gap-2 rounded-md border border-saffron bg-saffron-tint px-3.5 py-3">
          <TriangleAlert
            className="mt-0.5 h-3.5 w-3.5 flex-none text-saffron-fg"
            strokeWidth={1.75}
          />
          <p className="text-13 leading-relaxed text-stone-700">
            {t("warnCeiling", { count: handlist.total })}
          </p>
        </div>
      )}

      {errorMessage && (
        <p className="mt-3 text-13 leading-normal text-madder-deep">
          {errorMessage}
        </p>
      )}

      {handlist.total === 0 ? (
        <div className="mt-4 border-t border-stone-200 px-5 py-14 text-center">
          <b className="block font-serif text-lg font-semibold text-indigo">
            {t("emptyMembersHeading")}
          </b>
          <small className="mx-auto mt-1.5 block max-w-[44ch] text-sm leading-relaxed text-stone-500">
            {t("emptyMembersBody")}
          </small>
        </div>
      ) : (
        <>
          {/* The other entrance to the within-handlist scope. It is a
              plain GET to the search surface carrying this handlist's
              id, so typing here arrives with the verdigris pill already
              set — the tabs, the facets and the selection bar are the
              ones that already exist, rather than a second search
              living inside this page. A handlist whose type is not yet
              fixed has nothing to search, so it gets no field. */}
          {handlist.recordType && (
            <form
              method="get"
              action="/search"
              className="mt-5 flex justify-end"
            >
              <input type="hidden" name="handlist" value={handlist.id} />
              <div className="flex h-[34px] items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 focus-within:border-indigo">
                <Search
                  className="h-3.5 w-3.5 shrink-0 text-stone-400"
                  strokeWidth={1.75}
                />
                <input
                  type="search"
                  name="q"
                  placeholder={searchWithinLabel}
                  aria-label={searchWithinLabel}
                  className="h-full w-[15rem] min-w-0 bg-transparent font-sans text-13 text-stone-700 placeholder:text-stone-400 focus:outline-none"
                />
              </div>
              {/* Enter submits on its own; the button is here for the
                  people who cannot press it. */}
              <button type="submit" className="sr-only">
                {t("searchAction", { ns: "search" })}
              </button>
            </form>
          )}

          <div className="mt-4 border-t border-stone-200">
            {order.map((member, index) => (
              <MemberRow
                key={member.memberId}
                member={member}
                canEdit={handlist.canEdit}
                pending={pending}
                dragging={dragging === index}
                onDragStart={() => setDragging(index)}
                onDragEnd={() => setDragging(null)}
                onDropOn={() => {
                  if (dragging !== null) moveRow(dragging, index);
                  setDragging(null);
                }}
                onKeyMove={(delta) => moveRow(index, index + delta)}
                onRemove={() =>
                  submit({
                    _action: "remove-member",
                    memberId: member.memberId,
                  })
                }
                onResolve={(choice, successorId) =>
                  submit({
                    _action: "resolve",
                    memberId: member.memberId,
                    choice,
                    ...(successorId ? { successorId } : {}),
                  })
                }
              />
            ))}
          </div>

          <Pager
            page={page}
            pageSize={pageSize}
            total={handlist.total}
            hint={pagerHint}
            makeHref={(next) => {
              const params = new URLSearchParams(searchParams);
              params.set("page", String(next));
              return `?${params.toString()}`;
            }}
          />
        </>
      )}

      {dialog === "rename" && (
        <RenameHandlistDialog
          name={handlist.name}
          recordType={handlist.recordType}
          total={handlist.total}
          pending={pending}
          error={errorMessage}
          onCancel={() => setDialog(null)}
          onConfirm={(name) => submit({ _action: "rename", name })}
        />
      )}

      {dialog === "delete" && (
        <DeleteHandlistDialog
          name={handlist.name}
          recordType={handlist.recordType}
          total={handlist.total}
          shareCount={handlist.shareCount}
          pending={pending}
          error={errorMessage}
          onCancel={() => setDialog(null)}
          onConfirm={() => submit({ _action: "delete" })}
        />
      )}

      {dialog === "share" && (
        <ShareHandlistDialog
          name={handlist.name}
          recordType={handlist.recordType}
          total={handlist.total}
          candidates={candidates}
          workspaceVisible={handlist.workspaceVisible}
          pending={pending}
          error={errorMessage}
          onClose={() => setDialog(null)}
          onSetRole={(userId, role) =>
            submit({ _action: "share", userId, role })
          }
          onUnshare={(userId) => submit({ _action: "unshare", userId })}
          onToggleWorkspaceVisible={(next) =>
            submit({ _action: "visibility", visible: next ? "1" : "0" })
          }
        />
      )}
    </div>
  );
}

function HeaderButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-stone-300 bg-white px-3.5 text-13 font-semibold text-stone-700 hover:bg-stone-50"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * One member. Ordinary rows are a title, a mono meta line and a
 * remove; the three drifted states each add their own note and, where
 * a decision is owed, the affordance that settles it.
 */
function MemberRow({
  member,
  canEdit,
  pending,
  dragging,
  onDragStart,
  onDragEnd,
  onDropOn,
  onKeyMove,
  onRemove,
  onResolve,
}: {
  member: HandlistMemberRow;
  canEdit: boolean;
  pending: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropOn: () => void;
  onKeyMove: (delta: number) => void;
  onRemove: () => void;
  onResolve: (choice: string, successorId?: string) => void;
}) {
  const { t } = useTranslation("handlists");

  const tone =
    member.state === "split"
      ? "bg-saffron-tint"
      : member.state === "merged"
        ? "bg-indigo-wash"
        : member.state === "missing"
          ? "bg-stone-50"
          : "";

  const meta = [member.code, member.kind, member.dateExpression]
    .filter(Boolean)
    .join(" · ");

  // A tombstone cannot be dragged: it has nothing left to order.
  const draggable = canEdit && member.state !== "missing";

  return (
    <div
      className={`grid grid-cols-[22px_1fr_auto] items-start gap-2.5 border-b border-stone-100 px-1 py-3 ${tone} ${
        dragging ? "opacity-50" : ""
      }`}
      onDragOver={(e) => {
        if (draggable) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropOn();
      }}
    >
      {draggable ? (
        <span
          draggable
          tabIndex={0}
          role="button"
          aria-label={t("dragHandle")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              onKeyMove(-1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onKeyMove(1);
            }
          }}
          className="mt-0.5 cursor-grab text-stone-300 hover:text-stone-500"
        >
          <GripVertical className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
      ) : (
        <span aria-hidden="true" />
      )}

      <span>
        <p
          className={`font-serif text-15 leading-snug ${
            member.state === "missing"
              ? "text-stone-400 line-through"
              : "font-medium text-indigo"
          }`}
        >
          {member.title ?? member.memberId}
        </p>
        {meta && (
          <p className="mt-0.5 font-mono text-11 nums text-stone-500">{meta}</p>
        )}

        {member.state === "merged" && (
          <>
            <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-indigo-tint px-2 py-0.5 text-[0.625rem] font-semibold text-indigo">
              <GitMerge className="h-2.5 w-2.5" strokeWidth={1.75} />
              {member.collapsedFrom.length > 0
                ? t("noteCollapsed", { count: member.collapsedFrom.length })
                : t("noteMerged")}
            </span>
            {canEdit && (
              <button
                type="button"
                disabled={pending}
                onClick={() => onResolve("acknowledge")}
                className="mt-1.5 block text-xs font-semibold text-indigo hover:underline disabled:opacity-30"
              >
                {t("acknowledge")}
              </button>
            )}
          </>
        )}

        {member.state === "split" && (
          <>
            <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-saffron bg-saffron-tint px-2 py-0.5 text-[0.625rem] font-semibold text-saffron-fg">
              <Split className="h-2.5 w-2.5" strokeWidth={1.75} />
              {t("noteSplit")}
            </span>
            {canEdit && (
              <span className="mt-1.5 flex flex-wrap gap-1.5">
                <ChoiceButton
                  label={t("keepBoth")}
                  keep
                  disabled={pending}
                  onClick={() => onResolve("keep-both")}
                />
                {member.successors.map((successor) => (
                  <ChoiceButton
                    key={successor.id}
                    label={
                      successor.title || successor.code
                        ? t("keepOnly", {
                            name: successor.title ?? successor.code,
                          })
                        : t("keepOnlyUntitled")
                    }
                    disabled={pending}
                    onClick={() => onResolve("keep", successor.id)}
                  />
                ))}
                <ChoiceButton
                  label={t("removeFromHandlist")}
                  disabled={pending}
                  onClick={() => onResolve("remove")}
                />
              </span>
            )}
          </>
        )}

        {member.state === "missing" && (
          <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2 py-0.5 text-[0.625rem] font-semibold text-stone-600">
            <Trash2 className="h-2.5 w-2.5" strokeWidth={1.75} />
            {t("noteMissing")}
          </span>
        )}
      </span>

      {canEdit ? (
        <button
          type="button"
          disabled={pending}
          aria-label={t("removeFromHandlist")}
          title={t("removeFromHandlist")}
          onClick={onRemove}
          className="mt-0.5 text-stone-400 hover:text-madder disabled:opacity-30"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
    </div>
  );
}

function ChoiceButton({
  label,
  keep,
  disabled,
  onClick,
}: {
  label: string;
  keep?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 items-center rounded-lg border px-2.5 text-xs font-semibold disabled:opacity-30 ${
        keep
          ? "border-verdigris bg-verdigris-wash text-verdigris-deep"
          : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
      }`}
    >
      {label}
    </button>
  );
}
