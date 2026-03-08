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
