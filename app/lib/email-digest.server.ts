/**
 * Notification digest — email rendering.
 *
 * This module turns a recipient's coalesced notification items into the
 * subject line and HTML body of one digest email. It is deliberately
 * pure: no database, no clock, no transport. Everything it needs — the
 * translator fixed to the recipient's language, that language itself
 * (for the document's `lang`), the app identity, the items with their
 * labels and absolute URLs, the account-settings link, and the hosted
 * mark URL — arrives as an argument, so the renderer can be exercised
 * without a D1 binding or a mail provider.
 *
 * The body implements the email digest design round (archived handoff,
 * 2026-08-14) translated to mail-client mechanics: every style is
 * inlined on its element (Gmail strips <style>), the shell is nested
 * `role="presentation"` tables at a fixed 560px (Outlook's Word engine
 * ignores max-width on divs), and the type runs on system stacks —
 * Iowan/Georgia standing in for Spectral, never webfonts. The one
 * image is the pomegranate mark, a 2x PNG hosted on the apex (Gmail
 * strips base64 and drops SVG); width/height attributes make a
 * blocked image reserve its box, and the serif wordmark beside it
 * keeps the masthead branded with images off.
 *
 * The design's structural trick: only two full-width rules exist (one
 * closing the preamble, one opening the footer). Each group is opened
 * by a short 24×2 verdigris bar that IS the divider, so a single-group
 * digest — the common case in a small workspace — reads as deliberately
 * as a three-group one. Item rows are separated by hairlines set
 * between rows, never beside them, and item links carry colour with no
 * underline; the underlined "Account settings" link is the only one
 * that leaves the message. The footer closes with the unlinked
 * attribution colophon.
 *
 * Items are grouped by kind in a fixed order — rulings first, then
 * comment threads, then proposals awaiting a ruling — and only
 * non-empty groups render. The heading's plural form comes from
 * i18next's `_one`/`_other` selection on `count`; the count lives
 * inside the locked heading string and is never extracted.
 *
 * LABELS ARE UNTRUSTED. A digest item's label is archival data — a
 * proposed heading pulled off an index page, or a pair of authority
 * display names — so every label and every URL goes through
 * `escapeHtml` before it reaches the template. The translated copy
 * around them is our own and interpolates nothing but a count and the
 * app name.
 *
 * @version v0.7.0
 */
import type { TFunction } from "i18next";
import type { NOTIFICATION_KINDS } from "../db/schema";
import type { AppConfig } from "./config.server";

export interface DigestItem {
  kind: (typeof NOTIFICATION_KINDS)[number];
  decisionId: string;
  /** Human label: proposal name, or "A · B" pair names. Unescaped. */
  label: string;
  /** Absolute URL to the decision on its tenant host. */
  url: string;
}

/**
 * The order groups appear in, and the heading key each one uses. Fixed
 * rather than derived from the items so the digest's shape does not
 * depend on the order events happened to be enqueued in.
 */
const GROUPS: ReadonlyArray<{
  kind: (typeof NOTIFICATION_KINDS)[number];
  headingKey: string;
}> = [
  { kind: "decision_ruled", headingKey: "emails:ruledHeading" },
  { kind: "decision_comment", headingKey: "emails:commentHeading" },
  { kind: "proposal_filed", headingKey: "emails:filedHeading" },
];

// The design round's token values, hardcoded by necessity: no
// stylesheet survives a mail client. Names trace back to
// colors_and_type.css.
const VERDIGRIS = "#3E7A6E";
const VERDIGRIS_DEEP = "#2C5C53";
const INDIGO = "#1F2E4D";
const STONE_700 = "#44403C";
const STONE_500 = "#78716C";
const STONE_400 = "#A8A29E";
const STONE_200 = "#E7E5E4";
const STONE_100 = "#F5F5F4";

const SERIF = `'Iowan Old Style',Georgia,serif`;
const SANS = `ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif`;

/**
 * Escapes the five characters that can break out of HTML text or an
 * attribute value. Applied to labels (archival data) and to URLs, which
 * are assembled server-side from ids and slugs but are still
 * attribute-quoted here rather than trusted by construction.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders one recipient's digest. `t` must already be fixed to the
 * recipient's language; this function never negotiates a locale.
 * `markUrl` is the hosted 48×52 mark PNG, drawn at 24×26.
 */
export function renderDigestEmail(
  t: TFunction,
  appConfig: AppConfig,
  items: DigestItem[],
  accountUrl: string,
  locale: "en" | "es",
  markUrl: string,
): { subject: string; html: string } {
  const subject = t("emails:digestSubject", {
    count: items.length,
    appName: appConfig.appName,
  }) as string;

  const groups: string[] = [];
  for (const group of GROUPS) {
    const groupItems = items.filter((item) => item.kind === group.kind);
    if (groupItems.length === 0) continue;
    const heading = t(group.headingKey, { count: groupItems.length });
    // Hairlines sit BETWEEN rows (every row but the first), never
    // beside them — a one-row list is a finished list, not a stub.
    const rows = groupItems
      .map(
        (item, i) =>
          `<li style="margin:0;padding:7px 0;font-family:${SERIF};font-size:0.9375rem;line-height:1.45;color:${STONE_700};${
            i > 0 ? `border-top:1px solid ${STONE_100};` : ""
          }"><a href="${escapeHtml(item.url)}" style="color:${VERDIGRIS_DEEP};text-decoration:none;">${escapeHtml(item.label)}</a></li>`,
      )
      .join("");
    // The short verdigris bar IS the group divider: a table cell rather
    // than an empty div so Outlook cannot collapse it.
    groups.push(
      `<div style="margin-top:20px;">` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 9px;"><tr><td width="24" height="2" style="background-color:${VERDIGRIS};font-size:2px;line-height:2px;">&nbsp;</td></tr></table>` +
        `<h2 style="font-family:${SERIF};font-weight:600;font-size:1.0625rem;line-height:1.35;letter-spacing:-0.005em;color:${INDIGO};margin:0;">${heading}</h2>` +
        `<ul style="margin:10px 0 0;padding:0;list-style:none;">${rows}</ul>` +
        `</div>`,
    );
  }

  const content =
    `<p style="margin:0;font-size:0;line-height:0;">` +
    `<img src="${escapeHtml(markUrl)}" width="24" height="26" alt="${escapeHtml(appConfig.appName)}" style="display:inline-block;vertical-align:middle;border:0;margin:0 9px 0 0;">` +
    `<span style="display:inline-block;vertical-align:middle;font-family:${SERIF};font-weight:600;font-size:1.1875rem;line-height:1.1;letter-spacing:-0.005em;color:${VERDIGRIS};">${escapeHtml(appConfig.appName)}</span>` +
    `</p>` +
    `<p style="font-family:${SERIF};font-size:0.9375rem;line-height:1.6;color:${STONE_700};margin:12px 0 0;">${t("emails:intro")}</p>` +
    // Two structural rules only: this one closing the preamble, and the
    // footer's. Groups carry their own bars.
    `<div style="margin-top:20px;padding-top:4px;border-top:1px solid ${STONE_200};">${groups.join("")}</div>` +
    `<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid ${STONE_200};font-family:${SANS};font-size:0.75rem;line-height:1.65;color:${STONE_500};">${t("emails:manageLine")} <a href="${escapeHtml(accountUrl)}" style="color:${VERDIGRIS_DEEP};text-decoration:underline;">${t("emails:accountLinkLabel")}</a></p>` +
    `<p style="margin:9px 0 0;font-family:${SANS};font-size:0.6875rem;line-height:1.6;color:${STONE_400};">${t("emails:colophon")}</p>`;

  // Fixed-width table shell: Outlook's Word engine ignores max-width on
  // divs, so the 560px column is a real table width. lang drives
  // screen-reader pronunciation and hyphenation.
  const html =
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:${STONE_100};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${STONE_100};"><tr><td align="center" style="padding:24px;">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;background-color:#FFFFFF;border:1px solid ${STONE_200};border-radius:8px;"><tr><td style="padding:30px 36px 26px;font-family:${SANS};">` +
    content +
    `</td></tr></table>` +
    `</td></tr></table>` +
    `</body></html>`;

  return { subject, html };
}

// @version v0.7.0
