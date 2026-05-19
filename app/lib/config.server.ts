// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

/**
 * App Identity Configuration
 *
 * This module deals with the user-facing identity strings — app name
 * and sender email — that flow into login emails, magic-link copy,
 * and the page chrome. Values are read from environment variables
 * (`APP_NAME`, `SENDER_EMAIL`) with sensible defaults, so the
 * underlying template ships working out of the box and a specific
 * deployment customises through `wrangler.jsonc` `[vars]` or secrets.
 *
 * `getAppConfig` is the single resolver every route and helper goes
 * through; there is no hardcoded identity elsewhere in the codebase.
 *
 * @version v0.3.0
 */

export type AppConfig = {
  appName: string;
  senderEmail: string;
};

/**
 * Reads app identity from environment variables.
 *
 * Defaults are generic so the template works out of the box.
 * Set APP_NAME and SENDER_EMAIL in wrangler.jsonc [vars] or secrets
 * to customise for your deployment.
 */
export function getAppConfig(env: {
  APP_NAME?: string;
  SENDER_EMAIL?: string;
}): AppConfig {
  return {
    appName: env.APP_NAME || "Fisqua",
    senderEmail: env.SENDER_EMAIL || "noreply@example.com",
  };
}
