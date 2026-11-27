/**
 * Digitization — Scanner
 *
 * This page shows the tenant's Captua scanner to the people who work in
 * capture (`captureAccess(...).worker`), and lets those who manage it
 * (`captureAccess(...).manager`: the tenant's digitization admins and
 * its federation's stewards) pair a unit by the code it shows, make,
 * replace and revoke its link token, and erase the stored bucket keys.
 * These are administration: a worker who does not manage, such as a
 * federation staff grant, reads the device section, the token's dates
 * and the storage note without any control and is told that only
 * digitization administrators change the token (`canManage`), and the
 * action refuses them. The tenant must have the digitization
 * capability (a bare 404 otherwise, from the loader and the action
 * alike) and anyone else gets a bare 403.
 *
 * Four sections. Device: the scanner's appliance id (the name the
 * operator chose when minting its bucket keys), the linked unit's name
 * and device id once a pairing has stored them (in the scanner
 * `loadScanner` gives), the workspace, when the unit last called Fisqua,
 * and the mode it last reported (offline, backup or Fisqua) with when,
 * with a badge for where the link stands (not linked, waiting for the
 * first call, linked, revoked). Pair a unit, for managers only: with
 * stored keys that can be delivered, a code field and Look up, then a
 * confirmation of what the unit sent with its code, and Approve; without
 * them, or once they are erased, a sentence that Fisqua holds no bucket
 * keys for the workspace (and when they were erased), and no field.
 * Token: one of four states. With no token, Make token. Just made, the
 * token itself in a read-only field, shown once, with Copy token and
 * Done. Active, when the token was made and last used, with Replace token
 * and Revoke. Revoked, when, and that the unit's calls are refused, with
 * Make token. Storage: a note that a unit receives the bucket keys when
 * it is paired, once an operator has stored them, and, for managers while
 * the keys can be delivered, Erase stored keys.
 *
 * Replace, Revoke and Erase stored keys each open a confirmation step in
 * place of their button, which says what is lost, before anything is
 * posted; Revoke also asks why (reset or replaced; lost, stolen or
 * compromised) and posts the reason. After Look up, the page shows the
 * code's confirmation the same way. The page keeps one confirmation open
 * at a time. These confirmations and the error messages are in
 * `scanner-parts.tsx`. With no scanner yet, Make token first asks for the
 * unit's appliance id, the name in its key file, which the scanner then
 * keeps; the page checks it as the server does. Every action posts to
 * this route's action, the token and pairing actions with the scanner's
 * version as the page saw it and the pairing and erasing actions with the
 * stored keys' revision, and is carried out by `scannerTokenAction`
 * (`scanner.server.ts`), which audits it. An error is shown only in the
 * section the request was sent from, only once the answer has arrived,
 * and not after a confirmation has been opened since (`shownError`).
 * While a request is in flight the buttons that open a confirmation are
 * disabled. When a confirmation closes, and once nothing is in flight,
 * focus returns to the button that opened it, or to the code field for a
 * pairing, and to that section when the button is gone or disabled,
 * unless the person has moved focus elsewhere in the meantime (the
 * focused element is then neither the page's body nor absent).
 * Cancel also dismisses an error shown with the confirmation. After an
 * approval the code field is emptied and the page says when the unit
 * collects its settings; the page does not poll, and the device section
 * shows the new unit after the next load. After a compromised revoke or
 * an erasure the page says whether the stored keys were erased and
 * whether Fisqua's operators were told, and, when none was, asks the
 * administrator to contact one directly (`actionNotice`). React Router
 * refuses a post whose `Origin` names another host before the action
 * runs. A new
 * token arrives only in the answer to the action that made it and lives
 * in the page's state until Done; the loader never returns it, and
 * nothing writes it to the URL, the session or storage. The action's data
 * answer carries `Cache-Control: private, no-store`, and `headers` gives
 * a document answer (a post without JavaScript, whose HTML holds the
 * action's data) the same, since React Router keeps only cookies from an
 * action's own headers there.
 *
 * The loader also gives managers `storedKeys`, the state of the scanner
 * keys Fisqua stores for the tenant (the appliance id, whether they can
 * be delivered, when they were erased, and their revision, which an
 * approval and an erasure post back as `keysSeen`), or null when none
 * were stored; a worker who does not manage always gets null. It carries
 * no key material. The action also takes the two pairing intents,
 * `pair_lookup` and `pair_approve`, a revoke's `reason`, and `erase_keys`
 * (`scanner.server.ts`). It names the environment for the B2 key names
 * and the stored keys' binding from `CAPTURE_PAIRING_ENVIRONMENT`
 * (`pairingEnvironment`), and gives the action the Worker secret that
 * opens the stored keys and the environment to open them for (the
 * setting only when it is exactly `production` or `staging`, as the
 * collect route reads it), so that an approval is refused when they
 * cannot be opened, and the sender of the keys-erased notice to the
 * operators.
 *
 * @version v0.9.0
 */

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { data, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { Copy, Lock } from "lucide-react";
import { grantContext, impersonationContext, tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { useFormatters } from "../lib/use-formatters";
import type { DeviceState, PairingView, ScannerActionResult } from "../lib/capture/scanner.server";
import { SCANNER_NAME_PATTERN } from "../lib/capture/token";
import { BADGE_SHAPE } from "../components/workflow/status-badge";
import { CapturePageHeader } from "../components/capture/capture-parts";
import {
  actionNotice,
  Confirm,
  Field,
  focusAfterClose,
  PairConfirm,
  PRIMARY,
  SECONDARY,
  shownError,
  type ActionArea,
  type ActionNotice,
  type RevokeReason,
} from "../components/capture/scanner-parts";
import type { Route } from "./+types/_auth.admin.capture.scanner";
import { pageMeta, heading } from "../lib/page-title";

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    heading("capture:scanner.title"),
  );
}

export async function loader({ context }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "digitization");
  const user = context.get(userContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { captureAccess } = await import("~/lib/capture/screens.server");
  const { loadScanner, loadStoredKeysState, NO_SCANNER_VERSION } = await import("~/lib/capture/scanner.server");
  const db = drizzle(context.cloudflare.env.DB);
  const access = await captureAccess(db, tenant, user);
  if (!access.worker) throw new Response(null, { status: 403 });
  const scanner = await loadScanner(context.cloudflare.env.DB, tenant.id);
  return {
    scanner,
    version: scanner?.version ?? NO_SCANNER_VERSION,
    workspace: tenant.name,
    canManage: access.manager,
    storedKeys: access.manager ? await loadStoredKeysState(db, tenant.id) : null,
  };
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
  const { sendScannerKeysErasedEmail } = await import("~/lib/email.server");
  const { getAppConfig } = await import("~/lib/config.server");
  const { pairingEnvironment } = await import("~/lib/capture/appliance-key-names");
  const env = context.cloudflare.env;
  const d1 = env.DB;
  // The private key is a Worker secret, which the generated `Env` type does not list.
  const secrets = env as unknown as { CAPTURE_KEYS_PRIVATE_JWK?: string };
  const result = await scannerTokenAction(
    {
      d1,
      db: drizzle(d1),
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      environment: pairingEnvironment(env.CAPTURE_PAIRING_ENVIRONMENT),
      keysPrivateJwk: secrets.CAPTURE_KEYS_PRIVATE_JWK,
      keysEnvironment:
        env.CAPTURE_PAIRING_ENVIRONMENT === "production" || env.CAPTURE_PAIRING_ENVIRONMENT === "staging"
          ? env.CAPTURE_PAIRING_ENVIRONMENT
          : null,
      sendKeysErased: (to, locale, notice) =>
        sendScannerKeysErasedEmail(env.RESEND_API_KEY, to, notice, getAppConfig(env), locale),
    },
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

type Confirming = "replace" | "revoke" | "erase" | "pair" | null;

export default function CaptureScannerPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("capture");
  const { formatDate, formatDateTime } = useFormatters();
  const { scanner, version, workspace, canManage, storedKeys } = loaderData;
  const fetcher = useFetcher<ScannerActionResult>();
  const [token, setToken] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  // The section the last request was sent from; null once a confirmation
  // has been opened since, which dismisses that request's error.
  const [sentFrom, setSentFrom] = useState<ActionArea | null>(null);
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState<PairingView | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const revokeReason = useRef<RevokeReason | null>(null);
  const busy = fetcher.state !== "idle";

  // A new token is taken out of the answer once, into this page's state;
  // a looked-up code opens its confirmation, and the other successes
  // close whichever confirmation was open.
  const answer = fetcher.data;
  useEffect(() => {
    if (!answer) return;
    if (!answer.ok) {
      if (sentFrom === "pair") {
        setPairing(null);
        setConfirming((c) => (c === "pair" ? null : c));
      }
      return;
    }
    if (answer.step === "pair_lookup") {
      setPairing(answer.pairing);
      setConfirming("pair");
      return;
    }
    setConfirming(null);
    setPairing(null);
    if ("token" in answer && answer.token) setToken(answer.token);
    if (answer.step === "pair_approve") setCode("");
    const shown = actionNotice(answer, revokeReason.current);
    if (shown) setNotice(shown);
    // `sentFrom` is read as it was when this answer's request was sent.
  }, [answer]);

  // When a confirmation closes (Cancel, an error that closes it, or
  // success), focus goes back to what opened it: its button, or the code
  // field for a pairing. After a success the fetcher stays busy while the
  // page's data is reloaded, and the button is disabled, or gone once the
  // new data arrives (Revoke after the token is revoked, Erase after the
  // keys are erased), so the close is remembered (`closed`) and focus is
  // moved once nothing is in flight: to the button if it is there and
  // enabled, otherwise to its section (`focusAfterClose`). A new token
  // takes focus itself.
  const replaceButton = useRef<HTMLButtonElement>(null);
  const revokeButton = useRef<HTMLButtonElement>(null);
  const eraseButton = useRef<HTMLButtonElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const pairHeading = useRef<HTMLHeadingElement>(null);
  const tokenHeading = useRef<HTMLHeadingElement>(null);
  const storageSection = useRef<HTMLElement>(null);
  const lastOpen = useRef<Confirming>(null);
  const closed = useRef<Confirming>(null);
  useEffect(() => {
    const was = lastOpen.current;
    lastOpen.current = confirming;
    closed.current = confirming === null && was !== null ? was : null;
  }, [confirming]);
  useEffect(() => {
    const kind = closed.current;
    if (kind === null) return;
    const [opener, section] =
      kind === "replace"
        ? [replaceButton.current, tokenHeading.current]
        : kind === "revoke"
          ? [revokeButton.current, tokenHeading.current]
          : kind === "erase"
            ? [eraseButton.current, storageSection.current]
            : [codeField.current, pairHeading.current];
    const step = focusAfterClose({ busy, newToken: token !== null, opener });
    if (step === "wait") return;
    closed.current = null;
    // Focus moved by the person while the request was in flight stays where they put it.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    if (step === "opener") opener?.focus();
    else if (step === "section") section?.focus();
  }, [confirming, busy, token]);

  const done = () => {
    setToken(null);
    fetcher.reset();
  };

  /** Opens one confirmation and closes any other. */
  const open = (kind: Exclude<Confirming, null>) => {
    setConfirming(kind);
    setNotice(null);
    setSentFrom(null);
    if (kind !== "pair") setPairing(null);
  };

  const submit = (from: ActionArea, form: Record<string, string>) => {
    setSentFrom(from);
    setNotice(null);
    fetcher.submit(form, { method: "post" });
  };

  /** Closes the open confirmation, and dismisses an error shown with it. */
  const cancel = () => {
    setConfirming(null);
    setPairing(null);
    setSentFrom(null);
  };

  const post = (intent: "make" | "replace" | "revoke", extra: { name?: string; reason?: RevokeReason } = {}) => {
    const form: Record<string, string> = { intent, seen: version };
    if (intent !== "make") form.confirm = "yes";
    if (extra.name !== undefined) form.name = extra.name;
    if (extra.reason !== undefined) form.reason = extra.reason;
    revokeReason.current = intent === "revoke" ? (extra.reason ?? null) : null;
    submit("token", form);
  };

  const lookUp = () => {
    // Typing in the code field: a confirmation closed by Look up gives no focus back.
    lastOpen.current = null;
    setConfirming(null);
    setPairing(null);
    submit("pair", { intent: "pair_lookup", code });
  };

  const approve = () => {
    if (!pairing || !storedKeys) return;
    submit("pair", {
      intent: "pair_approve",
      code: pairing.code,
      seen: version,
      keysSeen: String(storedKeys.revision),
      confirm: "yes",
    });
  };

  const erase = () => {
    if (!storedKeys) return;
    submit("erase", { intent: "erase_keys", keysSeen: String(storedKeys.revision), confirm: "yes" });
  };

  const device: DeviceState = scanner?.deviceState ?? "not_linked";
  const errorIn = (from: ActionArea): string | null => shownError(t, from, { busy, sentFrom, answer });
  const noticeIn = (from: ActionArea): ReactNode =>
    notice && notice.area === from ? (
      <p role="status" className="mt-4 font-sans text-sm text-stone-600">
        {t(`scanner.${notice.key}`)}
      </p>
    ) : null;
  const tokenError = errorIn("token");
  const eraseError = errorIn("erase");

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
            <Field label={t("scanner.appliance_id")}>
              {scanner ? <span className="font-mono">{scanner.name}</span> : <span className="text-stone-500">{t("scanner.name_none")}</span>}
            </Field>
            {scanner?.unitName ? <Field label={t("scanner.unit_name")}>{scanner.unitName}</Field> : null}
            {scanner?.deviceId ? (
              <Field label={t("scanner.device_id")} hint={t("scanner.device_id_hint")}>
                <span className="font-mono">{scanner.deviceId}</span>
              </Field>
            ) : null}
            <Field label={t("scanner.workspace")}>{workspace}</Field>
            <Field label={t("scanner.last_called")}>
              {scanner?.lastSeenAt ? formatDateTime(scanner.lastSeenAt) : t("scanner.never")}
            </Field>
            <Field label={t("scanner.mode_label")}>
              {scanner?.mode ? (
                <>
                  {t(`scanner.mode.${scanner.mode}`)}
                  {scanner.modeReportedAt ? (
                    <span className="block text-xs text-stone-500">
                      {t("scanner.mode_reported", { date: formatDateTime(scanner.modeReportedAt) })}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-stone-500">{t("scanner.mode_none")}</span>
              )}
            </Field>
          </dl>
          <p className="mt-4 font-sans text-xs text-stone-500">{t("scanner.call_note")}</p>
        </section>

        {canManage ? (
          <section aria-labelledby="scanner-pair" className="rounded-lg border border-stone-200 bg-white p-6">
            <h2
              id="scanner-pair"
              ref={pairHeading}
              tabIndex={-1}
              className="font-serif text-lg font-semibold text-stone-700 focus:outline-none"
            >
              {t("scanner.pair_heading")}
            </h2>
            {storedKeys?.usable ? (
              <>
                {confirming === "pair" && pairing ? (
                  <PairConfirm pairing={pairing} workspace={workspace} busy={busy} onCancel={cancel} onApprove={approve} />
                ) : (
                  <PairForm
                    code={code}
                    onCode={setCode}
                    busy={busy}
                    error={errorIn("pair")}
                    onLookUp={lookUp}
                    inputRef={codeField}
                  />
                )}
                {noticeIn("pair")}
              </>
            ) : (
              <>
                {storedKeys?.erasedAt ? (
                  <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                    <Field label={t("scanner.pair_keys_erased")}>{formatDateTime(storedKeys.erasedAt)}</Field>
                  </dl>
                ) : null}
                <p className="mt-4 font-sans text-sm text-stone-600">{t("scanner.pair_no_keys")}</p>
              </>
            )}
          </section>
        ) : null}

        <section aria-labelledby="scanner-token" className="rounded-lg border border-stone-200 bg-white p-6">
          <h2
            id="scanner-token"
            ref={tokenHeading}
            tabIndex={-1}
            className="font-serif text-lg font-semibold text-stone-700 focus:outline-none"
          >
            {t("scanner.token_heading")}
          </h2>

          {token ? (
            <NewToken token={token} onDone={done} />
          ) : !canManage ? (
            <>
              {scanner?.tokenState === "active" ? (
                <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                  <Field label={t("scanner.token_field")}>
                    <span className="font-mono">{t("scanner.token_hidden")}</span>
                  </Field>
                  <Field label={t("scanner.made")}>{scanner.tokenCreatedAt ? formatDate(scanner.tokenCreatedAt) : t("scanner.never")}</Field>
                  <Field label={t("scanner.last_used")}>
                    {scanner.lastSeenAt ? formatDateTime(scanner.lastSeenAt) : t("scanner.never")}
                  </Field>
                </dl>
              ) : scanner?.tokenState === "revoked" && scanner.revokedAt ? (
                <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                  <Field label={t("scanner.revoked_at")}>{formatDateTime(scanner.revokedAt)}</Field>
                </dl>
              ) : null}
              <p className="mt-4 font-sans text-sm text-stone-600">{t("scanner.manage_note")}</p>
            </>
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
              {confirming === "replace" || confirming === "revoke" ? (
                <Confirm
                  key={confirming}
                  kind={confirming}
                  busy={busy}
                  onCancel={cancel}
                  onConfirm={(reason) => post(confirming, { reason })}
                />
              ) : (
                <>
                  <p className="mt-4 font-sans text-sm text-stone-600">{t("scanner.replace_note")}</p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button type="button" ref={replaceButton} className={SECONDARY} disabled={busy} onClick={() => open("replace")}>
                      {t("scanner.replace")}
                    </button>
                    <button type="button" ref={revokeButton} className={SECONDARY} disabled={busy} onClick={() => open("revoke")}>
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
                <FirstToken busy={busy} onMake={(name) => post("make", { name })} />
              )}
            </>
          )}

          {noticeIn("token")}
          {tokenError ? (
            <p role="alert" className="mt-4 font-sans text-sm text-madder-deep">
              {tokenError}
            </p>
          ) : null}
        </section>

        <section
          ref={storageSection}
          tabIndex={-1}
          aria-label={t("scanner.storage_label")}
          className="rounded-lg border border-stone-200 bg-stone-50 px-6 py-4 focus:outline-none"
        >
          <div className="flex items-center gap-3">
            <Lock className="h-4 w-4 shrink-0 text-stone-500" strokeWidth={1.5} aria-hidden="true" />
            <p className="font-sans text-sm text-stone-600">{t("scanner.storage_note")}</p>
          </div>
          {canManage && storedKeys?.usable ? (
            confirming === "erase" ? (
              <Confirm kind="erase" busy={busy} onCancel={cancel} onConfirm={erase} />
            ) : (
              <div className="mt-4">
                <button type="button" ref={eraseButton} className={SECONDARY} disabled={busy} onClick={() => open("erase")}>
                  {t("scanner.erase")}
                </button>
              </div>
            )
          ) : null}
          {noticeIn("erase")}
          {eraseError ? (
            <p role="alert" className="mt-4 font-sans text-sm text-madder-deep">
              {eraseError}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/**
 * The code field and Look up. The field takes what is typed as it is;
 * the server normalises the code. Look up is disabled while the field is
 * empty or a request is in flight, and an error is tied to the field.
 */
function PairForm({
  code,
  onCode,
  busy,
  error,
  onLookUp,
  inputRef,
}: {
  code: string;
  onCode: (code: string) => void;
  busy: boolean;
  error: string | null;
  onLookUp: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation("capture");
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();
  const empty = code.trim() === "";
  return (
    <form
      className="mt-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!empty && !busy) onLookUp();
      }}
    >
      <p className="font-sans text-sm text-stone-600">{t("scanner.pair_intro")}</p>
      <label htmlFor={fieldId} className="mt-4 block font-sans text-sm font-medium text-indigo">
        {t("scanner.pair_code")}
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          id={fieldId}
          name="code"
          value={code}
          onChange={(e) => onCode(e.currentTarget.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          aria-invalid={error !== null}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          className={`block w-full max-w-[12rem] rounded-md border bg-white px-3 py-2 font-mono text-[15px] text-indigo focus:outline-none focus:ring-1 ${
            error ? "border-madder focus:border-madder focus:ring-madder" : "border-stone-200 focus:border-indigo focus:ring-indigo"
          }`}
        />
        <button type="submit" className={PRIMARY} disabled={busy || empty}>
          {t("scanner.pair_lookup")}
        </button>
      </div>
      <p id={hintId} className="mt-1 font-sans text-xs text-stone-500">
        {t("scanner.pair_code_hint")}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="mt-1 font-sans text-xs text-madder-deep">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** Make token for a tenant with no scanner yet: asks for the unit's appliance id first. */
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
        {t("scanner.appliance_id")}
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
        {t("scanner.appliance_id_hint")}
      </p>
      {showError ? (
        <p id={errorId} className="mt-1 font-sans text-xs text-madder-deep">
          {t("scanner.appliance_id_invalid")}
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

// @version v0.9.0
