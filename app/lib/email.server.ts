/**
 * Outbound Email Helpers
 *
 * This module deals with the three transactional emails Fisqua sends
 * through Resend: the magic-link login mail, the invite-plus-magic-link
 * for users who do not yet have an account, and the notification sent
 * to an existing user when they are added to a new project. Each
 * helper assembles the subject and HTML body from `appConfig`'s
 * `appName` / `senderEmail` so the same code path produces correctly
 * branded mail across multi-tenant deployments without any hardcoded
 * strings.
 *
 * The HTML payloads are intentionally minimal — single-paragraph
 * messages with one call-to-action link and an expiry note where
 * relevant — to keep rendering robust across mail clients and to
 * avoid spam-filter heuristics that flag rich-template marketing
 * mail. Magic-link mail expires in fifteen minutes; invite mail in
 * seven days; both expiry windows are enforced server-side by the
 * tables the tokens live in, not by the email itself.
 *
 * @version v0.3.0
 */
import { Resend } from "resend";
import type { AppConfig } from "./config.server";

/**
 * Sends a magic link login email via Resend.
 */
export async function sendMagicLinkEmail(
  resendApiKey: string,
  to: string,
  magicLinkUrl: string,
  appConfig: AppConfig
): Promise<void> {
  const resend = new Resend(resendApiKey);

  await resend.emails.send({
    from: `${appConfig.appName} <${appConfig.senderEmail}>`,
    to,
    subject: `Your ${appConfig.appName} login link`,
    html: `
      <p>Click the link below to log in to ${appConfig.appName}:</p>
      <p><a href="${magicLinkUrl}">Log in to ${appConfig.appName}</a></p>
      <p>This link expires in 15 minutes. If you did not request this, you can safely ignore this email.</p>
    `.trim(),
  });
}

/**
 * Sends an invite email to a new user (combined invite + magic link).
 */
export async function sendNewUserInviteEmail(
  resendApiKey: string,
  to: string,
  inviterName: string,
  projectName: string,
  acceptUrl: string,
  appConfig: AppConfig
): Promise<void> {
  const resend = new Resend(resendApiKey);

  await resend.emails.send({
    from: `${appConfig.appName} <${appConfig.senderEmail}>`,
    to,
    subject: `${inviterName} invited you to ${projectName} on ${appConfig.appName}`,
    html: `
      <p>${inviterName} has invited you to join the project <strong>${projectName}</strong> on ${appConfig.appName}.</p>
      <p>Click the link below to accept the invitation and log in:</p>
      <p><a href="${acceptUrl}">Accept invitation</a></p>
      <p>This link expires in 7 days.</p>
    `.trim(),
  });
}

/**
 * Sends a notification email to an existing user who was added to a project.
 */
export async function sendExistingUserInviteEmail(
  resendApiKey: string,
  to: string,
  inviterName: string,
  projectName: string,
  projectUrl: string,
  appConfig: AppConfig
): Promise<void> {
  const resend = new Resend(resendApiKey);

  await resend.emails.send({
    from: `${appConfig.appName} <${appConfig.senderEmail}>`,
    to,
    subject: `You were added to ${projectName} on ${appConfig.appName}`,
    html: `
      <p>${inviterName} has added you to the project <strong>${projectName}</strong> on ${appConfig.appName}.</p>
      <p><a href="${projectUrl}">Go to project</a></p>
    `.trim(),
  });
}
