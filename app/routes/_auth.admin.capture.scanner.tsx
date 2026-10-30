/**
 * Digitization — Scanner
 *
 * This page shows the tenant's Captua scanner and lets the people who
 * manage capture work, the tenant's digitization admins and its federation's
 * stewards, make, replace and revoke its link token. The tenant must
 * have the digitization capability (a bare 404 otherwise, from the
 * loader and the action alike) and anyone else gets a bare 403.
 *
 * Three sections. Device: the scanner's name, the workspace, and when
 * the unit last called Fisqua, with a badge for where the link stands
 * (not linked, waiting for the first call, linked, revoked). Token: one
 * of four states. With no token, Make token. Just made, the token itself
 * in a read-only field, shown once, with Copy token and Done. Active,
 * when the token was made and last used, with Replace token and Revoke.
 * Revoked, when, and that the unit's calls are refused, with Make token. Storage: a note that an administrator
 * sets the scanner's bucket and keys.
 *
 * Replace and Revoke each open a confirmation step in place of the
 * buttons, which says what the unit loses, before anything is posted.
 * With no scanner yet, Make token first asks for the unit's short id,
 * the name in its key file, which the scanner then keeps; the page
 * checks it as the server does. Every action posts to this route's
 * action with the scanner's version as the page saw it, and is carried
 * out by `scannerTokenAction` (`scanner.server.ts`), which audits it.
 * React Router refuses a post whose `Origin` names another host before
 * the action runs. A new token arrives only in the answer to the
 * action that made it and lives in the page's state until Done; the
 * loader never returns it, and nothing writes it to the URL, the
 * session or storage. The action's data answer carries
 * `Cache-Control: private, no-store`, and `headers` gives a document
 * answer (a post without JavaScript, whose HTML holds the action's data)
 * the same, since React Router keeps only cookies from an action's own
 * headers there.
 *
 * @version@version v0.8.0
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { data, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { Copy, Lock } from "lucide-react";
import { grantContext, impersonationContext, tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { useFormatters } from "../lib/use-formatters";
import type { DeviceState, ScannerActionResult, ScannerView } from "../lib/capture/scanner.server";
import { SCANNER_NAME_PATTERN } from "../lib/capture/token";
import { BADGE_SHAPE } from "../components/workflow/status-badge";
import { CapturePageHeader } from "../components/capture/capture-parts";
import type { Route } from "./+types/_auth.admin.capture.scanner";

export async function loader({ context }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "digitization");
  const user = context.get(userContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { captureAccess } = await import("~/lib/capture/screens.server");
  const { loadScanner, NO_SCANNER_VERSION } = await import("~/lib/capture/scanner.server");
  const access = await captureAccess(drizzle(context.cloudflare.env.DB), tenant, user);
  if (!access.manager) throw new Response(null, { status: 403 });
  const scanner = await loadScanner(context.cloudflare.env.DB, tenant.id);
  return { scanner, version: scanner?.version ?? NO_SCANNER_VERSION, workspace: tenant.name };
}

const NO_STORE = "private, no-store";

export function headers(): HeadersInit {
  return { "Cache-Control": NO_STORE };
}

export async function action({ request, context }: Route.ActionArgs) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "digitization");
  if (request.method !== "POST") throw new Response(null, { status: 405, headers: { Allow: "POST" } });
  const user = context.get(userContext);
  const grant = context.get(grantContext);
  const impersonation = context.get(impersonationContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { scannerTokenAction, statusOf } = await import("~/lib/capture/scanner.server");
  const d1 = context.cloudflare.env.DB;
  const result = await scannerTokenAction(
    { d1, db: drizzle(d1), now: () => Date.now(), newId: () => crypto.randomUUID() },
    await request.formData(),
    tenant,
    {
      user,
      homeTenantId: grant?.homeTenantId ?? user.tenantId,
      impersonationSessionId: impersonation?.sessionId ?? null,
    },
  );
  return data(result, { status: statusOf(result), headers: { "Cache-Control": NO_STORE } });
}

const DEVICE_STYLES: Record<DeviceState, string> = {
  not_linked: "bg-stone-100 text-stone-600",
  waiting: "bg-saffron-tint text-saffron-deep",
  linked: "bg-verdigris-tint text-verdigris-deep",
  revoked: "bg-madder-tint text-madder-deep",
};

const PRIMARY =
  "inline-flex h-11 items-center gap-2 rounded-md bg-indigo px-4 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-30";
const SECONDARY =
  "inline-flex h-11 items-center gap-2 rounded-md border border-stone-200 bg-white px-4 font-sans text-sm font-semibold text-indigo hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30";
const DESTRUCTIVE =
  "inline-flex h-11 items-center gap-2 rounded-md bg-madder px-4 font-sans text-sm font-semibold text-parchment hover:bg-madder-deep disabled:cursor-not-allowed disabled:opacity-30";

type Confirming = "replace" | "revoke" | null;

export default function CaptureScannerPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("capture");
  const { formatDate, formatDateTime } = useFormatters();
  const { scanner, version, workspace } = loaderData;
  const fetcher = useFetcher<ScannerActionResult>();
  const [token, setToken] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const busy = fetcher.state !== "idle";

  // A new token is taken out of the answer once, into this page's state.
  const answer = fetcher.data;
  useEffect(() => {
    if (answer && answer.ok && answer.token) {
      setToken(answer.token);
      setConfirming(null);
    } else if (answer && answer.ok) {
      setConfirming(null);
    }
  }, [answer]);

  const done = () => {
    setToken(null);
    fetcher.reset();
  };

  const post = (intent: "make" | "replace" | "revoke", name?: string) => {
    const form: Record<string, string> = { intent, seen: version };
    if (intent !== "make") form.confirm = "yes";
    if (name !== undefined) form.name = name;
    fetcher.submit(form, { method: "post" });
  };

  const device: DeviceState = scanner?.deviceState ?? "not_linked";
  const error =
    answer && !answer.ok
      ? answer.error === "changed"
        ? t("scanner.error_changed")
        : answer.error === "invalid_name"
          ? t("scanner.unit_name_invalid")
          : t("scanner.error_failed")
      : null;

  return (
    <div className="mx-auto max-w-4xl px-2 py-6">
      <CapturePageHeader title={t("scanner.title")} intro={t("scanner.intro")} />

      <div className="mt-6 flex flex-col gap-5">
        <section aria-labelledby="scanner-device" className="rounded-lg border border-stone-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 id="scanner-device" className="font-serif text-lg font-semibold text-stone-700">
              {t("scanner.device_heading")}
            </h2>
            <span className={`${BADGE_SHAPE} ${DEVICE_STYLES[device]}`}>{t(`scanner.device.${device}`)}</span>
          </div>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label={t("scanner.name")}>
              {scanner ? <span className="font-mono">{scanner.name}</span> : <span className="text-stone-500">{t("scanner.name_none")}</span>}
            </Field>
            <Field label={t("scanner.workspace")}>{workspace}</Field>
            <Field label={t("scanner.last_called")}>
              {scanner?.lastSeenAt ? formatDateTime(scanner.lastSeenAt) : t("scanner.never")}
            </Field>
          </dl>
          <p className="mt-4 font-sans text-xs text-stone-500">{t("scanner.call_note")}</p>
        </section>

        <section aria-labelledby="scanner-token" className="rounded-lg border border-stone-200 bg-white p-6">
          <h2 id="scanner-token" className="font-serif text-lg font-semibold text-stone-700">
            {t("scanner.token_heading")}
          </h2>

          {token ? (
            <NewToken token={token} onDone={done} />
          ) : scanner?.tokenState === "active" ? (
            <>
              <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                <Field label={t("scanner.token_field")}>
                  <span className="font-mono">{t("scanner.token_hidden")}</span>
                </Field>
                <Field label={t("scanner.made")}>{scanner.tokenCreatedAt ? formatDate(scanner.tokenCreatedAt) : t("scanner.never")}</Field>
                <Field label={t("scanner.last_used")}>
                  {scanner.lastSeenAt ? formatDateTime(scanner.lastSeenAt) : t("scanner.never")}
                </Field>
              </dl>
              {confirming ? (
                <Confirm
                  kind={confirming}
                  busy={busy}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => post(confirming)}
                />
              ) : (
                <>
                  <p className="mt-4 font-sans text-sm text-stone-600">{t("scanner.replace_note")}</p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button type="button" className={SECONDARY} onClick={() => setConfirming("replace")}>
                      {t("scanner.replace")}
                    </button>
                    <button type="button" className={DESTRUCTIVE} onClick={() => setConfirming("revoke")}>
                      {t("scanner.revoke")}
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              {scanner?.tokenState === "revoked" && scanner.revokedAt ? (
                <>
                  <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                    <Field label={t("scanner.revoked_at")}>{formatDateTime(scanner.revokedAt)}</Field>
                  </dl>
                  <p className="mt-4 font-sans text-sm text-stone-600">{t("scanner.revoked_body")}</p>
                </>
              ) : (
                <p className="mt-4 font-sans text-sm text-stone-600">{t("scanner.none_body")}</p>
              )}
              {scanner ? (
                <div className="mt-4">
                  <button type="button" className={PRIMARY} disabled={busy} onClick={() => post("make")}>
                    {t("scanner.make")}
                  </button>
                </div>
              ) : (
                <FirstToken busy={busy} onMake={(name) => post("make", name)} />
              )}
            </>
          )}

          {error ? (
            <p role="alert" className="mt-4 font-sans text-sm text-madder-deep">
              {error}
            </p>
          ) : null}
        </section>

        <section
          aria-label={t("scanner.storage_label")}
          className="flex items-center gap-3 rounded-lg border border-stone-200 bg-stone-50 px-6 py-4"
        >
          <Lock className="h-4 w-4 shrink-0 text-stone-500" strokeWidth={1.5} aria-hidden="true" />
          <p className="font-sans text-sm text-stone-600">{t("scanner.storage_note")}</p>
        </section>
      </div>
    </div>
  );
}

/** Make token for a tenant with no scanner yet: asks for the unit's short id first. */
function FirstToken({ busy, onMake }: { busy: boolean; onMake: (name: string) => void }) {
  const { t } = useTranslation("capture");
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const valid = SCANNER_NAME_PATTERN.test(name);
  const showError = tried && !valid;
  return (
    <form
      className="mt-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (valid) onMake(name);
      }}
    >
      <label htmlFor={fieldId} className="font-sans text-sm font-medium text-indigo">
        {t("scanner.unit_name")}
      </label>
      <input
        id={fieldId}
        name="name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value.trim())}
        maxLength={32}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={showError}
        aria-describedby={showError ? `${hintId} ${errorId}` : hintId}
        className={`mt-1 block w-full max-w-xs rounded-md border bg-white px-3 py-2 font-mono text-[15px] text-indigo focus:outline-none focus:ring-1 ${
          showError ? "border-madder focus:border-madder focus:ring-madder" : "border-stone-200 focus:border-indigo focus:ring-indigo"
        }`}
      />
      <p id={hintId} className="mt-1 font-sans text-xs text-stone-500">
        {t("scanner.unit_name_hint")}
      </p>
      {showError ? (
        <p id={errorId} className="mt-1 font-sans text-xs text-madder-deep">
          {t("scanner.unit_name_invalid")}
        </p>
      ) : null}
      <div className="mt-4">
        <button type="submit" className={PRIMARY} disabled={busy}>
          {t("scanner.make")}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-sans text-xs font-medium text-stone-500">{label}</dt>
      <dd className="mt-1 font-sans text-[15px] text-indigo">{children}</dd>
    </div>
  );
}

function NewToken({ token, onDone }: { token: string; onDone: () => void }) {
  const { t } = useTranslation("capture");
  const fieldId = useId();
  const noteId = useId();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopy("copied");
    } catch {
      setCopy("failed");
      field.current?.select();
    }
  };

  return (
    <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={fieldId} className="font-sans text-sm font-medium text-indigo">
          {t("scanner.new_token")}
        </label>
        <span className={`${BADGE_SHAPE} bg-saffron-tint text-saffron-deep`}>{t("scanner.shown_once")}</span>
      </div>
      <input
        ref={field}
        id={fieldId}
        readOnly
        value={token}
        aria-describedby={noteId}
        spellCheck={false}
        autoComplete="off"
        className="mt-2 w-full rounded-md border border-stone-200 bg-white px-3 py-2 font-mono text-[13px] text-indigo focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
        onFocus={(e) => e.currentTarget.select()}
      />
      <p id={noteId} className="mt-2 font-sans text-xs text-stone-500">
        {t("scanner.copy_note")}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className={SECONDARY} onClick={copyToken}>
          <Copy className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
          {t("scanner.copy")}
        </button>
        <button type="button" className={PRIMARY} onClick={onDone}>
          {t("scanner.done")}
        </button>
        <span role="status" className="font-sans text-xs text-stone-600">
          {copy === "copied" ? t("scanner.copied") : copy === "failed" ? t("scanner.copy_failed") : ""}
        </span>
      </div>
    </div>
  );
}

function Confirm({
  kind,
  busy,
  onCancel,
  onConfirm,
}: {
  kind: "replace" | "revoke";
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("capture");
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div role="group" aria-labelledby={titleId} className="mt-4 rounded-md border border-madder p-4">
      <h3 id={titleId} ref={heading} tabIndex={-1} className="font-sans text-[15px] font-semibold text-indigo focus:outline-none">
        {t(`scanner.confirm_${kind}_title`)}
      </h3>
      <p className="mt-1 font-sans text-sm text-stone-600">{t(`scanner.confirm_${kind}_body`)}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className={SECONDARY} onClick={onCancel} disabled={busy}>
          {t("scanner.cancel")}
        </button>
        <button type="button" className={kind === "revoke" ? DESTRUCTIVE : PRIMARY} onClick={onConfirm} disabled={busy}>
          {t(`scanner.confirm_${kind}`)}
        </button>
      </div>
    </div>
  );
}

// @version@version v0.8.0
