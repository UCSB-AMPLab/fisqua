/**
 * Vocabularies — the roles a new federation starts with
 *
 * This data file holds the minimal set of document and place roles a
 * new federation starts from: for people and corporate bodies,
 * `creator`, `subject` and `mentioned`; for places, `created`, `subject`
 * and `mentioned`. Each federation adds the rest of its roles itself.
 * `scripts/commands/seed-federation-vocabulary.ts` seeds it with
 * `--set starter-roles`.
 *
 * Every row here is the same row, with the same group, position and
 * labels, as in the Neogranadina set
 * (`scripts/data/vocabularies/neogranadina-roles.ts`), which the
 * institution-records fill wrote from the constants and the locale
 * files. The three person roles fall in the `production` group, where
 * the fill put them, at the positions the fill gave them there (1, 5
 * and 6). A federation that starts from this set can later take the
 * Neogranadina set, or any part of it, with no conflict.
 *
 * @version v0.9.0
 */
import type { RoleVocabularySet } from "./neogranadina-roles";

export const STARTER_ROLES: RoleVocabularySet = {
  kind: "roles",
  name: "starter-roles",
  existingGroups: [],
  groups: [
    { code: "production", position: 1, es: "Producción y menciones", en: "Production & mentions" },
  ],
  entityRoles: [
    { code: "creator", group: "production", position: 1, es: "Creador", en: "Creator" },
    { code: "mentioned", group: "production", position: 5, es: "Mencionado", en: "Mentioned" },
    { code: "subject", group: "production", position: 6, es: "Tema", en: "Subject" },
  ],
  placeRoles: [
    { code: "created", position: 1, es: "Creado", en: "Created" },
    { code: "subject", position: 2, es: "Tema", en: "Subject" },
    { code: "mentioned", position: 3, es: "Mencionado", en: "Mentioned" },
  ],
};

// @version v0.9.0
