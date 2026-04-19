// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

/**
 * Central configuration module for app identity.
 *
 * All user-facing identity strings (app name, sender email) are read
 * from environment variables with sensible defaults. This is the single
 * source of truth -- no hardcoded identity elsewhere in the codebase.
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
