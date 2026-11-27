/**
 * Language Parameter
 *
 * This module deals with the `?lang=` query parameter on the client.
 * The i18next middleware treats `?lang=` as an explicit language choice
 * and records it in the `lang` cookie on every GET that carries it. A
 * page where the user then picks a language another way (the settings
 * buttons) has to take the parameter out of its own URL; otherwise the
 * revalidation that follows the choice, and any reload, would send the
 * old `?lang=` again and overwrite the new choice.
 *
 * `withoutLanguageParam` takes a location's search string and returns
 * it without `lang` (an empty string when nothing else remains), or
 * null when there was no `lang` to remove, so the caller can skip the
 * navigation.
 *
 * @version v0.9.0
 */

export const LANGUAGE_PARAM = "lang";

export function withoutLanguageParam(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.has(LANGUAGE_PARAM)) return null;
  params.delete(LANGUAGE_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

// @version v0.9.0
