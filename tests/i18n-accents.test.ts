import { describe, it, expect } from "vitest";

import common from "../app/locales/es/common";
import auth from "../app/locales/es/auth";
import dashboard from "../app/locales/es/dashboard";
import description from "../app/locales/es/description";
import viewer from "../app/locales/es/viewer";
import workflow from "../app/locales/es/workflow";
import admin from "../app/locales/es/admin";
import project from "../app/locales/es/project";
import comments from "../app/locales/es/comments";

/**
 * Recursively extract all leaf string values from a nested object.
 */
function extractStrings(obj: Record<string, unknown>): string[] {
  const strings: string[] = [];
  for (const value of Object.values(obj)) {
    if (typeof value === "string") {
      strings.push(value);
    } else if (typeof value === "object" && value !== null) {
      strings.push(...extractStrings(value as Record<string, unknown>));
    }
  }
  return strings;
}

/**
 * Known unaccented patterns that should never appear in Spanish translations.
 * Each entry: [regex pattern, correct form].
 */
const ACCENT_PATTERNS: [RegExp, string][] = [
  [/\bpagina\b/i, "página"],
  [/\bsesion\b/i, "sesión"],
  [/\bdescripcion\b/i, "descripción"],
  [/\bconfiguracion\b/i, "configuración"],
  [/\badministracion\b/i, "administración"],
  [/\belectronico\b/i, "electrónico"],
  [/\bdireccion\b/i, "dirección"],
  [/\brevision\b/i, "revisión"],
  [/\basignacion\b/i, "asignación"],
  [/\bsegmentacion\b/i, "segmentación"],
  [/\baccion\b/i, "acción"],
  [/\binvitacion\b/i, "invitación"],
  [/\bvalidacion\b/i, "validación"],
  [/\bvalido\b/i, "válido"],
  [/\btitulo\b/i, "título"],
  [/\bultimo\b/i, "último"],
  [/\bultima\b/i, "última"],
  [/\bdivision\b/i, "división"],
  [/\bcorreccion\b/i, "corrección"],
  [/\bidentificacion\b/i, "identificación"],
  [/\bseccion\b/i, "sección"],
  [/\bextension\b/i, "extensión"],
  [/\bposicion\b/i, "posición"],
  [/\bimagenes\b/i, "imágenes"],
  [/\bminimo\b/i, "mínimo"],
];

const localeFiles: Record<string, Record<string, unknown>> = {
  common,
  auth,
  dashboard,
  description,
  viewer,
  workflow,
  admin,
  project,
  comments,
};

for (const [fileName, locale] of Object.entries(localeFiles)) {
  describe(`es/${fileName}.ts accents`, () => {
    const strings = extractStrings(locale);

    for (const [pattern, correct] of ACCENT_PATTERNS) {
      it(`should not contain unaccented "${pattern.source}" (use "${correct}")`, () => {
        const matches = strings.filter((s) => pattern.test(s));
        expect(
          matches,
          `Found unaccented "${pattern.source}" in es/${fileName}.ts:\n${matches.map((m) => `  - "${m}"`).join("\n")}`,
        ).toHaveLength(0);
      });
    }
  });
}
