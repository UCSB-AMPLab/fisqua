/**
 * Handlists — the index
 *
 * Every working set this person can reach, in one table: the ones
 * they own, the ones colleagues shared with them, and — under All —
 * the ones the workspace has been shown. Three tabs rather than three
 * pages, because they are three readings of one list and a tab keeps
 * the count comparable.
 *
 * A ROW SAYS FOUR THINGS. What the handlist is called, in serif,
 * because it is a name a person wrote. What it holds — a mono count
 * over the kind of thing, since a handlist is typed and the type is
 * load-bearing everywhere downstream. Who owns it, and whether it
 * arrived by a share. And when it last moved, as an ISO stamp: these
 * are machine facts and read the same in both languages.
 *
 * THE LOCKED ROW IS THE POINT OF THE PAGE'S HONESTY. A handlist of
 * entities or places is admin-only, because its module is. Someone
 * shared such a handlist and then demoted still SEES the row, carrying
 * its reason — residue is explained, never silently absent, and a row
 * that vanished would leave a colleague's "I shared it with you" with
 * no answer. Such a row offers neither Open nor Export, which is the
 * same absence rule the rest of the surface follows: an action a
 * person cannot take is not rendered and then refused.
 *
 * EXPORT IS OFFERED TO EVERY MEMBER who can open the handlist. The
 * 2026-08-15 tier ruling put the distinction one step further in —
 * rendered artifacts for readers, machine-readable data for admins —
 * so the question this page answers is only whether the handlist can
 * be opened at all. What the export page then offers is its own
 * business; it arrives in a later phase, and this page links to it
 * regardless rather than growing a stub.
 *
 * There is no guard on the loader. A handlist belongs to a person, not
 * to a module, so the reach is decided per handlist inside
 * `handlists.server` — owner, sharee or workspace-visible, always
 * inside the tenant, in the same statement as the read.
 *
 * @version v0.7.0
 */
import { useEffect, useState } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Download, List, Lock, Plus, Users } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { CreateHandlistDialog } from "~/components/handlists/create-handlist-dialog";
import { HOLDS_KEYS } from "~/components/handlists/handlist-labels";
import type {
  HandlistLockReason,
  HandlistSummary,
} from "~/lib/handlists.server";
import type { Route } from "./+types/_auth.handlists";

/** The three readings of the same list. */
type Tab = "mine" | "shared" | "all";

const TABS: Tab[] = ["mine", "shared", "all"];

const TAB_LABEL_KEYS: Record<Tab, string> = {
  mine: "tabMine",
  shared: "tabShared",
  all: "tabAll",
};

const EMPTY_HEADING_KEYS: Record<Tab, string> = {
  mine: "emptyMineHeading",
  shared: "emptySharedHeading",
  all: "emptyAllHeading",
};

const EMPTY_BODY_KEYS: Record<Tab, string> = {
  mine: "emptyMineBody",
  shared: "emptySharedBody",
  all: "emptyAllBody",
};

/** Machine reason → the sentence the reader gets. */
const REASON_KEYS: Record<HandlistLockReason, string> = {
  "authorities-admin-only": "reasonAuthoritiesAdminOnly",
};

/** What the create dialog gets back. */
type CreateResult =
  | { ok: true; id: string }
  | {
      ok: false;
      error: "duplicate-name" | "name-required" | "generic";
      /** The name that clashed, so the sentence can name it back. */
      name: string;
    };

function readTab(value: string | null): Tab {
  return value === "shared" || value === "all" ? value : "mine";
}

/** Mono stamps stay ISO in both locales — they are machine facts. */
function isoDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { listForUser } = await import("~/lib/handlists.server");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  const tab = readTab(new URL(request.url).searchParams.get("tab"));
  const rows = await listForUser(db, tenant, user, tab);

  return { tab, rows, userId: user.id };
}

// ---------------------------------------------------------------------------
// Action — creating an empty handlist from this page
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { createHandlist } = await import("~/lib/handlists.server");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  const formData = await request.formData();
  const name = ((formData.get("name") as string) || "").trim();
  if (name === "") {
    return { ok: false as const, error: "name-required" as const, name };
  }

  try {
    // No members: the type stays open until the first add fixes it.
    const created = await createHandlist(db, tenant, user, { name });
    return { ok: true as const, id: created.id };
  } catch (err) {
    // A duplicate name belongs under the field the person just typed
    // in, not on an error page — it is the one thing that can go wrong
    // here and it is entirely recoverable.
    if (err instanceof Response && (err.status === 409 || err.status === 400)) {
      return {
        ok: false as const,
        error:
          err.status === 409
            ? ("duplicate-name" as const)
            : ("name-required" as const),
        name,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HandlistsIndexPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("handlists");
  const { tab, rows, userId } = loaderData;
  const [searchParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const fetcher = useFetcher<CreateResult>();

  const pending = fetcher.state !== "idle";
  const result = fetcher.data;

  // A landed create closes the dialog; a refused one keeps it open
  // with the reason under the field, which is where the name that
  // clashed was typed.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setCreating(false);
  }, [fetcher.state, fetcher.data]);

  const createError =
    result && !result.ok
      ? result.error === "duplicate-name"
        ? t("errorDuplicateName", { name: result.name })
        : result.error === "name-required"
          ? t("errorNameRequired")
          : t("errorGeneric")
      : undefined;

  const tabLink = (next: Tab) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    return `?${params.toString()}`;
  };

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-8">
      <div className="flex items-start justify-between gap-5">
        <div>
          <h1 className="font-serif text-[1.75rem] font-semibold leading-[1.2] tracking-[-0.005em] text-indigo">
            {t("title")}
          </h1>
          <p className="mt-2 max-w-[64ch] font-serif text-base leading-[1.6] text-indigo-soft">
            {t("intro")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mt-1 inline-flex h-[38px] flex-none items-center gap-2 rounded-md bg-indigo px-4 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {t("newHandlist")}
        </button>
      </div>

      <nav className="mt-6 flex gap-2">
        {TABS.map((value) => (
          <Link
            key={value}
            to={tabLink(value)}
            className={`rounded-full px-3 py-1 text-13 font-semibold transition-colors ${
              tab === value
                ? "bg-indigo text-parchment"
                : "border border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
            }`}
          >
            {t(TAB_LABEL_KEYS[value])}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="mt-4 border-t border-stone-200 px-5 py-14 text-center">
          <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-indigo-tint">
            <List className="h-7 w-7 text-indigo" strokeWidth={1.5} />
          </span>
          <b className="mt-3.5 block font-serif text-lg font-semibold text-indigo">
            {t(EMPTY_HEADING_KEYS[tab])}
          </b>
          <small className="mx-auto mt-1.5 block max-w-[44ch] text-sm leading-relaxed text-stone-500">
            {t(EMPTY_BODY_KEYS[tab])}
          </small>
        </div>
      ) : (
        <table className="mt-4 w-full border-collapse">
          <thead>
            <tr>
              <th className="whitespace-nowrap border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-11 font-semibold uppercase tracking-[0.08em] text-stone-400">
                {t("colHandlist")}
              </th>
              <th className="w-[88px] whitespace-nowrap border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-11 font-semibold uppercase tracking-[0.08em] text-stone-400">
                {t("colHolds")}
              </th>
              <th className="w-[120px] whitespace-nowrap border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-11 font-semibold uppercase tracking-[0.08em] text-stone-400">
                {t("colOwner")}
              </th>
              <th className="w-[104px] whitespace-nowrap border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-11 font-semibold uppercase tracking-[0.08em] text-stone-400">
                {t("colUpdated")}
              </th>
              <th className="w-[148px] border-b border-stone-200 bg-stone-50 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <HandlistRow key={row.id} row={row} userId={userId} />
            ))}
          </tbody>
        </table>
      )}

      {creating && (
        <CreateHandlistDialog
          pending={pending}
          error={createError}
          onCancel={() => setCreating(false)}
          onConfirm={(name) =>
            fetcher.submit({ name }, { method: "post", action: "/handlists" })
          }
        />
      )}
    </div>
  );
}

function HandlistRow({
  row,
  userId,
}: {
  row: HandlistSummary;
  userId: string;
}) {
  const { t } = useTranslation("handlists");
  const mine = row.ownerId === userId;

  return (
    <tr className="hover:bg-stone-50">
      <td className="border-b border-stone-100 px-3 py-3 align-top">
        <span className="block font-serif text-base font-semibold leading-snug text-indigo">
          {row.name}
        </span>
        {row.description && (
          <span className="mt-1 block text-xs leading-normal text-stone-500">
            {row.description}
          </span>
        )}
        {row.shareCount > 0 && (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-indigo-tint px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.06em] text-indigo">
            <Users className="h-2.5 w-2.5 text-indigo" strokeWidth={1.75} />
            {t("sharedWith", { count: row.shareCount })}
          </span>
        )}
        {row.workspaceVisible && (
          <span className="ml-1.5 mt-1 inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.06em] text-stone-600">
            {t("workspaceVisibleBadge")}
          </span>
        )}
        {row.locked && row.lockedReason && (
          <span className="mt-1.5 flex items-start gap-1.5 text-xs leading-normal text-stone-500">
            <Lock className="mt-0.5 h-3 w-3 flex-none text-stone-400" strokeWidth={1.75} />
            <span>
              <b className="font-semibold text-stone-600">{t("lockedLabel")}</b>{" "}
              {t(REASON_KEYS[row.lockedReason])}
            </span>
          </span>
        )}
      </td>
      <td className="border-b border-stone-100 px-3 py-3 align-top">
        <span className="block font-mono text-13 nums text-indigo">
          {row.memberCount}
        </span>
        <span className="mt-px block text-11 text-stone-500">
          {row.recordType ? t(HOLDS_KEYS[row.recordType]) : t("holdsEmpty")}
        </span>
      </td>
      <td className="border-b border-stone-100 px-3 py-3 align-top">
        <span className="block text-13 text-stone-600">
          {mine ? t("ownerYou") : (row.ownerName ?? row.ownerEmail)}
        </span>
        {!mine && row.role === "viewer" && (
          <span className="mt-1 inline-flex items-center rounded-full bg-indigo-tint px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.06em] text-indigo">
            {t("roleViewOnly")}
          </span>
        )}
        {!mine && row.role === "editor" && (
          <span className="mt-1 inline-flex items-center rounded-full bg-indigo-tint px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.06em] text-indigo">
            {t("roleCanEdit")}
          </span>
        )}
      </td>
      <td className="border-b border-stone-100 px-3 py-3 align-top">
        <time className="whitespace-nowrap font-mono text-xs nums text-stone-400">
          {isoDay(row.updatedAt)}
        </time>
      </td>
      <td className="border-b border-stone-100 px-3 py-3 align-top text-right">
        {!row.locked && (
          <span className="flex justify-end gap-3 whitespace-nowrap">
            <Link
              to={`/admin/exports?handlist=${row.id}`}
              className="inline-flex items-center gap-1.5 text-13 font-semibold text-indigo hover:underline"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
              {t("export")}
            </Link>
            <Link
              to={`/handlists/${row.id}`}
              className="text-13 font-semibold text-indigo hover:underline"
            >
              {t("open")}
            </Link>
          </span>
        )}
      </td>
    </tr>
  );
}
