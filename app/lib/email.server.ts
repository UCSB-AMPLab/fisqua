/**
 * Outbound Email Helpers
 *
 * This module deals with the transactional emails Fisqua sends through
 * Resend: the magic-link login mail, the invite-plus-magic-link for
 * users who do not yet have an account, the notification sent to an
 * existing user when they are added to a new project, and the notice to
 * an operator that a workspace's scanner keys must be revoked, sent when
 * its stored keys were erased or its unit was reported compromised,
 * which names each pair of B2 keys the operator must revoke by hand. Each
 * helper assembles the subject and HTML body from `appConfig`'s
 * `appName` / `senderEmail`, so the same code path produces correctly
 * branded mail across multi-tenant deployments.
 *
 * Each helper takes the language to write in, already chosen by its
 * caller through `chooseEmailLocale` (`app/lib/email-locale.server.ts`):
 * `generateMagicLink` for the sign-in link and `createInvite` for the
 * two invitations, and the Scanner page's action, from the operator's
 * saved language, for the keys-erased notice. The copy comes from the `emails` namespace through a
 * translator fixed to that language, and the document's `<html lang>`
 * names it, so screen readers pronounce the mail correctly. Both
 * languages share one template per email: the same link in the same
 * place and the same expiry note.
 *
 * The HTML payloads are intentionally minimal — short paragraphs with
 * one call-to-action link and an expiry note where relevant — to keep
 * rendering robust across mail clients and to avoid spam-filter
 * heuristics that flag rich-template marketing mail. Magic-link mail
 * expires in fifteen minutes; invite mail in seven days; both expiry
 * windows are enforced server-side by the tables the tokens live in,
 * not by the email itself.
 *
 * Every value interpolated into an HTML body (the app name, the
 * inviter's name, the project name, the link, the workspace and key
 * names) is escaped; the subject
 * is plain text and carries the values as they are.
 *
 * @version v0.9.0
 */
import { Resend } from "resend";
import type { AppConfig } from "./config.server";
import { emailTranslator } from "./email-locale.server";
import type { SupportedLanguage } from "./language-cookie.server";

/** Escapes the five characters that can break out of HTML text or an attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wraps the body paragraphs in a document that names its language. */
function htmlDocument(
  locale: SupportedLanguage,
  subject: string,
  paragraphs: string[],
): string {
  return (
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(subject)}</title></head><body>` +
    paragraphs.map((p) => `<p>${p}</p>`).join("") +
    `</body></html>`
  );
}

/**
 * Hands one message to Resend and gives back Resend's answer, which
 * carries `error` (and no data) when Resend refused the message. Only
 * the keys-erased notice reads it; the other emails ignore it.
 */
async function send(
  resendApiKey: string,
  appConfig: AppConfig,
  to: string,
  subject: string,
  html: string,
): Promise<{ error: unknown }> {
  const resend = new Resend(resendApiKey);
  const answer = await resend.emails.send({
    from: `${appConfig.appName} <${appConfig.senderEmail}>`,
    to,
    subject,
    html,
  });
  return { error: answer?.error ?? null };
}

/**
 * Sends a magic link login email via Resend, in `locale`.
 */
export async function sendMagicLinkEmail(
  resendApiKey: string,
  to: string,
  magicLinkUrl: string,
  appConfig: AppConfig,
  locale: SupportedLanguage
): Promise<void> {
  const t = await emailTranslator(locale);
  const appName = escapeHtml(appConfig.appName);
  const subject = t("emails:magicLinkSubject", {
    appName: appConfig.appName,
  });
  const html = htmlDocument(locale, subject, [
    t("emails:magicLinkIntro", { appName }),
    `<a href="${escapeHtml(magicLinkUrl)}">${t("emails:magicLinkAction", { appName })}</a>`,
    t("emails:magicLinkExpiry"),
  ]);
  await send(resendApiKey, appConfig, to, subject, html);
}

/**
 * Sends an invite email to a new user (combined invite + magic link),
 * in `locale`.
 */
export async function sendNewUserInviteEmail(
  resendApiKey: string,
  to: string,
  inviterName: string,
  projectName: string,
  acceptUrl: string,
  appConfig: AppConfig,
  locale: SupportedLanguage
): Promise<void> {
  const t = await emailTranslator(locale);
  const subject = t("emails:newUserInviteSubject", {
    inviterName,
    projectName,
    appName: appConfig.appName,
  });
  const html = htmlDocument(locale, subject, [
    t("emails:newUserInviteBody", {
      inviterName: escapeHtml(inviterName),
      projectName: `<strong>${escapeHtml(projectName)}</strong>`,
      appName: escapeHtml(appConfig.appName),
    }),
    t("emails:newUserInviteInstruction"),
    `<a href="${escapeHtml(acceptUrl)}">${t("emails:newUserInviteAction")}</a>`,
    t("emails:newUserInviteExpiry"),
  ]);
  await send(resendApiKey, appConfig, to, subject, html);
}

/**
 * Sends a notification email to an existing user who was added to a
 * project, in `locale`.
 */
export async function sendExistingUserInviteEmail(
  resendApiKey: string,
  to: string,
  inviterName: string,
  projectName: string,
  projectUrl: string,
  appConfig: AppConfig,
  locale: SupportedLanguage
): Promise<void> {
  const t = await emailTranslator(locale);
  const subject = t("emails:existingUserInviteSubject", {
    projectName,
    appName: appConfig.appName,
  });
  const html = htmlDocument(locale, subject, [
    t("emails:existingUserInviteBody", {
      inviterName: escapeHtml(inviterName),
      projectName: `<strong>${escapeHtml(projectName)}</strong>`,
      appName: escapeHtml(appConfig.appName),
    }),
    `<a href="${escapeHtml(projectUrl)}">${t("emails:existingUserInviteAction")}</a>`,
  ]);
  await send(resendApiKey, appConfig, to, subject, html);
}

/**
 * Sends an operator the notice that a workspace's scanner keys must be
 * revoked in Backblaze B2, in `locale`: the workspace's name and slug,
 * whether Fisqua erased its stored copy of the keys (`erased`) or held
 * none, and the names of each pair of B2 keys to revoke, the upload key
 * and the read key. It carries no key id and no secret. It fails with a
 * fixed message, which names neither the recipient nor the keys, when
 * Resend refuses the message, so that its caller can tell that no
 * message went out.
 */
export async function sendScannerKeysErasedEmail(
  resendApiKey: string,
  to: string,
  notice: { workspace: string; slug: string; erased: boolean; keys: Array<{ write: string; read: string }> },
  appConfig: AppConfig,
  locale: SupportedLanguage
): Promise<void> {
  const t = await emailTranslator(locale);
  const appName = escapeHtml(appConfig.appName);
  const subject = t("emails:keysErasedSubject", { workspace: notice.workspace });
  const where = { appName, workspace: escapeHtml(notice.workspace), slug: escapeHtml(notice.slug) };
  const html = htmlDocument(locale, subject, [
    notice.erased ? t("emails:keysErasedBody", where) : t("emails:keysNotStoredBody", where),
    notice.erased ? t("emails:keysErasedInstruction", { appName }) : t("emails:keysNotStoredInstruction"),
    ...notice.keys.flatMap((pair) => [
      t("emails:keysErasedWriteKey", { name: `<code>${escapeHtml(pair.write)}</code>` }),
      t("emails:keysErasedReadKey", { name: `<code>${escapeHtml(pair.read)}</code>` }),
    ]),
    t("emails:keysErasedPairing"),
  ]);
  const { error } = await send(resendApiKey, appConfig, to, subject, html);
  if (error) throw new Error("The keys-erased notice was refused for sending");
}

// @version v0.9.0
