/**
 * Digitization — Queue
 *
 * This page is the workspace's digitization queue: the descriptions
 * people added for capture, and every volume with retakes outstanding,
 * which enters the queue by itself and leaves it when its last retake is
 * approved or excluded. The Captua unit reads the same queue over the
 * capture link (contract 1.7). It is for the people who work in
 * capture (`captureAccess(...).worker`): the tenant's digitization
 * admins, its federation's stewards and its federation's staff grants;
 * the tenant must have the digitization capability (a bare 404
 * otherwise, from the loader and the action alike) and anyone else gets
 * a bare 403. The items come from `loadQueueItems`, withdrawn entries
 * left out.
 *
 * Filters are search parameters, so a filtered view survives a reload:
 * `state`, `assignee` (an operator's username: their items and the
 * unassigned ones, as the unit's Cola opens for them; or `none` for the
 * unassigned only), `job`, and `scanner` when the workspace has more
 * than one.
 *
 * Rows can be ticked, and the ticked ones assigned to an active
 * operator, unassigned, withdrawn (after a confirmation step), or
 * exported. A row moves up or down among the added entries; a retake
 * stays at the top and does not move. A row's job and note are edited
 * in place. The whole queue, or the ticked rows, downloads as the
 * contract §3 digitisation-list file, for a unit without the link.
 *
 * A scanner whose unit last reported a mode other than Fisqua (offline
 * or backup) gets a warning under the header: it is not picking up
 * entries. Adding to the queue is never refused for it.
 *
 * Every change posts to this route's action with an `intent` and is
 * carried out by `queue.server.ts`; a refusal comes back as
 * `{ ok: false, error }` and shows as a sentence above the table. The
 * export is a document post (not a fetcher), so the browser saves the
 * file the action answers with.
 *
 * @version v0.9.0
 */

import { useState } from "react";
import { Form, useFetcher, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Download, ScanLine } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { useFormatters } from "../lib/use-formatters";
import { QUEUE_STATES, knownSkipReason, type QueueState } from "../lib/capture/queue";
import { CAPTURE_QUEUE_ACTIONS, type CaptureQueueAction } from "../lib/validation/enums";
import { BADGE_SHAPE } from "../components/workflow/status-badge";
import { CaptureEmptyState, CapturePageHeader } from "../components/capture/capture-parts";
import type { Route } from "./+types/_auth.admin.capture.queue";
import { pageMeta, heading } from "../lib/page-title";

async function gate(context: Route.LoaderArgs["context"]) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "digitization");
  const user = context.get(userContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { captureAccess } = await import("~/lib/capture/screens.server");
  const db = drizzle(context.cloudflare.env.DB);
  if (!(await captureAccess(db, tenant, user)).worker) throw new Response(null, { status: 403 });
  return { tenant, user, db };
}

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    heading("capture:dqueue.title"),
  );
}

export async function loader({ context }: Route.LoaderArgs) {
  const { tenant, db } = await gate(context);
  const { loadQueueItems, loadOperators, loadScanners } = await import("~/lib/capture/queue.server");
  const items = (await loadQueueItems(db, tenant.id, Date.now())).filter((i) => i.withdrawnAt === null);
  return {
    items: items.map((i) => ({
      id: i.id,
      origin: i.origin,
      descriptionId: i.descriptionId,
      referenceCode: i.referenceCode,
      title: i.title,
      action: i.action,
      entryAction: i.entryAction,
      note: i.note,
      scannerId: i.scannerId,
      assignee: i.assignee,
      addedAt: i.addedAt,
      addedByName: i.addedByName,
      skippedReason: i.skippedReason,
      retakes: i.retakes.length,
      state: i.state,
    })),
    operators: await loadOperators(db, tenant.id),
    scanners: await loadScanners(db, tenant.id),
  };
}

function readIds(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") throw new Response(null, { status: 405, headers: { Allow: "POST" } });
  const { tenant, db } = await gate(context);
  const q = await import("~/lib/capture/queue.server");
  const deps = { db, now: () => Date.now(), newId: () => crypto.randomUUID() };
  const form = await request.formData();
  const intent = form.get("intent");
  const ids = readIds(form.get("ids"));
  try {
    switch (intent) {
      case "assign": {
        const to = String(form.get("to") ?? "");
        // A scanner id is a UUID, so the first "|" ends it.
        const cut = to.indexOf("|");
        const scannerId = cut > 0 ? to.slice(0, cut) : "";
        const username = cut > 0 ? to.slice(cut + 1) : "";
        if (!scannerId || !username) return Response.json({ ok: false, error: "operator" }, { status: 400 });
        await q.assignItems(deps, tenant.id, ids, { scannerId, username });
        return { ok: true as const };
      }
      case "unassign":
        await q.assignItems(deps, tenant.id, ids, null);
        return { ok: true as const };
      case "withdraw":
        await q.withdrawEntries(deps, tenant.id, ids);
        return { ok: true as const };
      case "move": {
        const direction = form.get("direction") === "up" ? "up" : "down";
        await q.moveEntry(deps, tenant.id, String(form.get("id") ?? ""), direction);
        return { ok: true as const };
      }
      case "job": {
        const action = String(form.get("action") ?? "");
        if (!(CAPTURE_QUEUE_ACTIONS as readonly string[]).includes(action)) {
          return Response.json({ ok: false, error: "invalid" }, { status: 400 });
        }
        await q.setItemJob(deps, tenant.id, String(form.get("id") ?? ""), {
          action: action as CaptureQueueAction,
          note: String(form.get("note") ?? ""),
        });
        return { ok: true as const };
      }
      case "export": {
        const all = (await q.loadQueueItems(db, tenant.id, deps.now())).filter((i) => i.withdrawnAt === null);
        const chosen = ids.length > 0 ? all.filter((i) => ids.includes(i.id)) : all;
        const now = deps.now();
        const file = await q.digitisationList(db, tenant, chosen, { id: deps.newId(), at: now });
        const date = new Date(now).toISOString().slice(0, 10);
        return new Response(JSON.stringify(file, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="digitisation-list_${tenant.slug}_queue_${date}.json"`,
            "Cache-Control": "private, no-store",
          },
        });
      }
      default:
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    }
  } catch (thrown) {
    if (thrown instanceof q.QueueError) {
      return Response.json({ ok: false, error: thrown.code }, { status: thrown.code === "not-found" ? 404 : 400 });
    }
    throw thrown;
  }
}

type Item = Route.ComponentProps["loaderData"]["items"][number];

const STATE_STYLES: Record<QueueState, string> = {
  queued: "bg-stone-100 text-stone-600",
  on_unit: "bg-indigo-tint text-indigo",
  captured: "bg-indigo-tint text-indigo",
  in_review: "bg-saffron-tint text-saffron-deep",
  retakes_requested: "bg-madder-tint text-madder-deep",
  approved: "bg-verdigris-tint text-verdigris-deep",
  skipped: "bg-saffron-tint text-saffron-deep",
};

const SELECT =
  "h-9 rounded-md border border-stone-200 bg-white px-2 font-sans text-[13px] text-stone-700 focus:border-indigo focus:outline-none";
const SECONDARY =
  "inline-flex h-9 items-center gap-2 rounded-md border border-stone-200 bg-white px-3 font-sans text-[13px] font-semibold text-indigo hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30";
const PRIMARY =
  "inline-flex h-9 items-center gap-2 rounded-md bg-indigo px-3 font-sans text-[13px] font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-30";
const DESTRUCTIVE =
  "inline-flex h-9 items-center gap-2 rounded-md bg-madder px-3 font-sans text-[13px] font-semibold text-parchment hover:bg-madder-deep disabled:cursor-not-allowed disabled:opacity-30";

export default function DigitizationQueuePage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("capture");
  // A known skip code is named in words; anything else the unit sends is
  // shown as received.
  const skipReasonText = (reason: string) => {
    const code = knownSkipReason(reason);
    return code ? t(`dqueue.skip_reason.${code}`) : reason;
  };
  const { formatDate } = useFormatters();
  const { items, operators, scanners } = loaderData;
  const [params, setParams] = useSearchParams();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [assignTo, setAssignTo] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const busy = fetcher.state !== "idle";

  const state = params.get("state");
  const assignee = params.get("assignee");
  const job = params.get("job");
  const scanner = params.get("scanner");
  const shown = items.filter(
    (i) =>
      (!state || i.state === state) &&
      (!job || i.action === job) &&
      (!scanner || i.scannerId === scanner || i.scannerId === null) &&
      (!assignee || (assignee === "none" ? i.assignee === null : i.assignee === assignee || i.assignee === null)),
  );
  const shownIds = new Set(shown.map((i) => i.id));
  const selected = [...ticked].filter((id) => shownIds.has(id));
  const active = operators.filter((o) => o.active);
  const scannerName = (id: string | null) => scanners.find((s) => s.id === id)?.name ?? null;
  const movable = shown.filter((i) => i.retakes === 0 && i.origin === "queue");

  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true, preventScrollReset: true });
  };

  const post = (form: Record<string, string>) => fetcher.submit(form, { method: "post" });
  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allTicked = shown.length > 0 && selected.length === shown.length;

  const failed = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error ?? "generic" : null;

  return (
    <div className="mx-auto max-w-6xl px-2 py-6">
      <CapturePageHeader title={t("dqueue.title")} intro={t("dqueue.intro")} />

      {/* A scanner reporting a mode other than Fisqua does not pick entries up; queueing still works. */}
      {scanners
        .filter((s) => s.revokedAt === null && (s.mode === "offline" || s.mode === "backup"))
        .map((s) => (
          <p
            key={s.id}
            role="status"
            className="mt-4 rounded-lg border border-saffron-tint bg-saffron-tint px-4 py-3 font-sans text-sm text-saffron-deep"
          >
            {t(`dqueue.mode_warning_${s.mode}`, { name: s.name || t("scanner.name_none") })}
          </p>
        ))}

      {items.length === 0 ? (
        <CaptureEmptyState icon={ScanLine} title={t("dqueue.empty_title")} body={t("dqueue.empty_body")} />
      ) : (
        <>
          <div role="group" aria-label={t("dqueue.filters_label")} className="mt-6 flex flex-wrap items-end gap-3">
            <FilterSelect label={t("dqueue.filter_state")} value={state ?? ""} onChange={(v) => filter("state", v)}>
              <option value="">{t("dqueue.filter_all_states")}</option>
              {QUEUE_STATES.map((s) => (
                <option key={s} value={s}>
                  {t(`dqueue.state.${s}`)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label={t("dqueue.filter_assignee")} value={assignee ?? ""} onChange={(v) => filter("assignee", v)}>
              <option value="">{t("dqueue.filter_everyone")}</option>
              <option value="none">{t("dqueue.filter_unassigned")}</option>
              {[...new Set(operators.map((o) => o.username))].map((u) => (
                <option key={u} value={u}>
                  {t("dqueue.filter_operator", { name: u })}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label={t("dqueue.filter_job")} value={job ?? ""} onChange={(v) => filter("job", v)}>
              <option value="">{t("dqueue.filter_all_jobs")}</option>
              {CAPTURE_QUEUE_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(`dqueue.job.${a.replace(/-/g, "_")}`)}
                </option>
              ))}
            </FilterSelect>
            {scanners.length > 1 ? (
              <FilterSelect label={t("dqueue.filter_scanner")} value={scanner ?? ""} onChange={(v) => filter("scanner", v)}>
                <option value="">{t("dqueue.filter_all_scanners")}</option>
                {scanners.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </FilterSelect>
            ) : null}
            <span className="flex-1" />
            <Form method="post" reloadDocument>
              <input type="hidden" name="intent" value="export" />
              <input type="hidden" name="ids" value={JSON.stringify(selected)} />
              <button type="submit" className={SECONDARY}>
                <Download className="h-4 w-4" strokeWidth={1.5} />
                {selected.length > 0 ? t("dqueue.export_selected", { count: selected.length }) : t("dqueue.export_all")}
              </button>
            </Form>
          </div>

          {selected.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-indigo-tint bg-indigo-wash px-4 py-2">
              <span className="text-13 font-semibold text-indigo">{t("dqueue.selected", { count: selected.length })}</span>
              <span className="flex-1" />
              {confirming ? (
                <>
                  <span className="text-13 text-stone-700">{t("dqueue.withdraw_confirm", { count: selected.length })}</span>
                  <button
                    type="button"
                    disabled={busy}
                    className={DESTRUCTIVE}
                    onClick={() => {
                      post({ intent: "withdraw", ids: JSON.stringify(selected) });
                      setConfirming(false);
                      setTicked(new Set());
                    }}
                  >
                    {t("dqueue.withdraw")}
                  </button>
                  <button type="button" className={SECONDARY} onClick={() => setConfirming(false)}>
                    {t("dqueue.cancel")}
                  </button>
                </>
              ) : (
                <>
                  <label className="sr-only" htmlFor="dqueue-assign">
                    {t("dqueue.assign_to")}
                  </label>
                  <select id="dqueue-assign" className={SELECT} value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                    <option value="">{t("dqueue.assign_to")}</option>
                    {active.map((o) => (
                      <option key={`${o.scannerId}|${o.username}`} value={`${o.scannerId}|${o.username}`}>
                        {scanners.length > 1 ? `${o.displayName} (${o.scannerName})` : o.displayName}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy || assignTo === ""}
                    className={PRIMARY}
                    onClick={() => post({ intent: "assign", ids: JSON.stringify(selected), to: assignTo })}
                  >
                    {t("dqueue.assign")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={SECONDARY}
                    onClick={() => post({ intent: "unassign", ids: JSON.stringify(selected) })}
                  >
                    {t("dqueue.unassign")}
                  </button>
                  <button type="button" disabled={busy} className={SECONDARY} onClick={() => setConfirming(true)}>
                    {t("dqueue.withdraw")}
                  </button>
                </>
              )}
            </div>
          ) : null}

          {active.length === 0 ? <p className="mt-3 font-sans text-xs text-stone-500">{t("dqueue.no_operators")}</p> : null}
          {failed ? (
            <p role="alert" className="mt-3 font-sans text-sm text-madder-deep">
              {t(`dqueue.error.${["operator", "retakes", "not_found", "invalid"].includes(failed.replace(/-/g, "_")) ? failed.replace(/-/g, "_") : "generic"}`)}
            </p>
          ) : null}

          {shown.length === 0 ? (
            <p className="mt-6 font-sans text-sm text-stone-500">{t("dqueue.empty_filter")}</p>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200 bg-white">
              <table className="w-full min-w-[1000px] text-left font-sans text-sm">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
                    <th scope="col" className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={t("dqueue.select_all")}
                        checked={allTicked}
                        onChange={() => setTicked(allTicked ? new Set() : new Set(shown.map((i) => i.id)))}
                      />
                    </th>
                    <th scope="col" className="px-4 py-3">{t("columns.reference_code")}</th>
                    <th scope="col" className="px-4 py-3">{t("columns.title")}</th>
                    <th scope="col" className="px-4 py-3">{t("dqueue.column_job")}</th>
                    <th scope="col" className="px-4 py-3">{t("dqueue.column_assignee")}</th>
                    <th scope="col" className="px-4 py-3">{t("columns.state")}</th>
                    <th scope="col" className="px-4 py-3">{t("dqueue.column_added")}</th>
                    <th scope="col" className="px-4 py-3">{t("columns.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item) => {
                    const at = movable.findIndex((m) => m.id === item.id);
                    return (
                      <tr key={item.id} className="border-b border-stone-100 align-top last:border-b-0">
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            aria-label={t("dqueue.select_row", { code: item.referenceCode })}
                            checked={ticked.has(item.id)}
                            onChange={() => toggle(item.id)}
                          />
                        </td>
                        <td className="px-4 py-3 font-mono text-[13px] text-indigo">
                          <a href={`/admin/descriptions/${item.descriptionId}`} className="hover:underline">
                            {item.referenceCode}
                          </a>
                        </td>
                        <td className="px-4 py-3 font-serif text-[15px] text-stone-700">{item.title}</td>
                        <td className="px-4 py-3">
                          {editing === item.id ? (
                            <JobEditor item={item} busy={busy} onSave={(form) => { post(form); setEditing(null); }} onCancel={() => setEditing(null)} />
                          ) : (
                            <>
                              <span className="text-stone-700">{t(`dqueue.job.${item.action.replace(/-/g, "_")}`)}</span>
                              {item.retakes > 0 ? (
                                <span className="block text-xs text-stone-500">{t("dqueue.retake_openings", { count: item.retakes })}</span>
                              ) : null}
                              {item.note ? <span className="mt-0.5 block max-w-[28ch] text-xs text-stone-500">{item.note}</span> : null}
                            </>
                          )}
                        </td>
                        <td className="px-4 py-3 text-stone-700">
                          {item.assignee ?? (item.scannerId ? scannerName(item.scannerId) : null) ?? (
                            <span className="text-stone-500">{t("dqueue.unassigned")}</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`${BADGE_SHAPE} ${STATE_STYLES[item.state]}`}>{t(`dqueue.state.${item.state}`)}</span>
                          {item.state === "skipped" && item.skippedReason ? (
                            <p className="mt-1 max-w-[28ch] text-xs text-stone-500">{skipReasonText(item.skippedReason)}</p>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-stone-700">
                          {formatDate(item.addedAt)}
                          {item.addedByName ? <span className="block text-xs text-stone-500">{item.addedByName}</span> : null}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <span className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              disabled={busy || at <= 0}
                              aria-label={t("dqueue.move_up", { code: item.referenceCode })}
                              className="rounded p-1 text-indigo hover:bg-stone-100 disabled:opacity-30"
                              onClick={() => post({ intent: "move", id: item.id, direction: "up" })}
                            >
                              <ArrowUp className="h-4 w-4" strokeWidth={1.5} />
                            </button>
                            <button
                              type="button"
                              disabled={busy || at < 0 || at === movable.length - 1}
                              aria-label={t("dqueue.move_down", { code: item.referenceCode })}
                              className="rounded p-1 text-indigo hover:bg-stone-100 disabled:opacity-30"
                              onClick={() => post({ intent: "move", id: item.id, direction: "down" })}
                            >
                              <ArrowDown className="h-4 w-4" strokeWidth={1.5} />
                            </button>
                            <button
                              type="button"
                              className="ml-1 font-semibold text-indigo hover:underline"
                              onClick={() => setEditing(item.id)}
                            >
                              {t("dqueue.edit_job")}
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-4 font-sans text-xs text-stone-500">{t("dqueue.footnote")}</p>
        </>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 font-sans text-xs font-semibold text-stone-600">
      {label}
      <select className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

/** A row's job and note, edited in place. */
function JobEditor({
  item,
  busy,
  onSave,
  onCancel,
}: {
  item: Item;
  busy: boolean;
  onSave: (form: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("capture");
  const [action, setAction] = useState<string>(item.entryAction);
  const [note, setNote] = useState(item.note ?? "");
  return (
    <div className="flex min-w-[220px] flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs font-semibold text-stone-600">
        {t("dqueue.column_job")}
        <select className={SELECT} value={action} onChange={(e) => setAction(e.target.value)}>
          {CAPTURE_QUEUE_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {t(`dqueue.job.${a.replace(/-/g, "_")}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-stone-600">
        {t("dqueue.note")}
        <textarea
          className="rounded-md border border-stone-200 px-2 py-1 font-sans text-[13px] font-normal text-stone-700"
          rows={2}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <span className="flex gap-2">
        <button type="button" disabled={busy} className={PRIMARY} onClick={() => onSave({ intent: "job", id: item.id, action, note })}>
          {t("dqueue.save")}
        </button>
        <button type="button" className={SECONDARY} onClick={onCancel}>
          {t("dqueue.cancel")}
        </button>
      </span>
    </div>
  );
}

// @version v0.9.0
