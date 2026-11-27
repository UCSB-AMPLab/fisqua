/**
 * Email language
 *
 * This module deals with choosing the language an email is written in
 * and handing out a translator fixed to that language. Every email
 * Fisqua sends (the sign-in link, the two project invitations and the
 * notification digest) goes through it, so all of them follow one rule.
 *
 * `chooseEmailLocale` takes the candidate languages and returns the
 * first supported one, in this order:
 *   1. the recipient's saved `users.locale`, when the recipient is a
 *      known user who has chosen a language;
 *   2. the default language of the workspace the email concerns
 *      (`tenants.default_locale`);
 *   3. the language of the request that triggered the email, as the
 *      i18next middleware resolved it (which already weighs `?lang=`,
 *      the `lang` cookie, the workspace default and Accept-Language);
 *   4. Spanish.
 * A null, missing or unsupported value at any step passes to the next.
 * The digest is sent from the cron, with no request, so it supplies
 * only the first two.
 *
 * `requestLanguage` reads the language the i18next middleware resolved
 * for the request an action is handling, for callers to pass on as the
 * request step. It returns null rather than throwing when the context
 * carries no i18next instance (an action exercised outside the
 * middleware), so a missing language never stops an email.
 *
 * `workspaceDefaultLocale` reads a workspace's default language from
 * D1, returning null when the workspace has none or does not exist.
 *
 * `emailTranslator` returns a `t` fixed to one language. Initialising
 * an i18next instance loads the full resource bundle, so each
 * language's translator is built once per isolate and reused: two
 * languages, two instances.
 *
 * @version v0.9.0
 */
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { TFunction } from "i18next";
import { tenants } from "../db/schema";
import { createServerI18nInstance, getLocale } from "../middleware/i18next";
import {
  isSupportedLanguage,
  type SupportedLanguage,
} from "./language-cookie.server";

export type EmailLocaleSources = {
  /** The recipient's saved `users.locale`, when the recipient is a known user. */
  userLocale?: string | null;
  /** The `tenants.default_locale` of the workspace the email concerns. */
  workspaceLocale?: string | null;
  /** The resolved language of the request that triggered the email. */
  requestLocale?: string | null;
};

/** The language an email is written in; Spanish when no source names one. */
export function chooseEmailLocale(
  sources: EmailLocaleSources,
): SupportedLanguage {
  for (const candidate of [
    sources.userLocale,
    sources.workspaceLocale,
    sources.requestLocale,
  ]) {
    if (isSupportedLanguage(candidate)) return candidate;
  }
  return "es";
}

/** The language the middleware resolved for this request, or null. */
export function requestLanguage(
  context: Parameters<typeof getLocale>[0],
): string | null {
  try {
    return getLocale(context);
  } catch {
    return null;
  }
}

/** The workspace's default language, or null when it sets none. */
export async function workspaceDefaultLocale(
  db: DrizzleD1Database<any>,
  tenantId: string,
): Promise<SupportedLanguage | null> {
  const row = await db
    .select({ defaultLocale: tenants.defaultLocale })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .get();
  return isSupportedLanguage(row?.defaultLocale) ? row.defaultLocale : null;
}

const translatorCache = new Map<SupportedLanguage, Promise<TFunction>>();

/** A translator fixed to `locale`, built once per isolate. */
export function emailTranslator(locale: SupportedLanguage): Promise<TFunction> {
  let cached = translatorCache.get(locale);
  if (!cached) {
    cached = createServerI18nInstance(locale).then((instance) =>
      instance.getFixedT(locale),
    );
    translatorCache.set(locale, cached);
  }
  return cached;
}

// @version v0.9.0
