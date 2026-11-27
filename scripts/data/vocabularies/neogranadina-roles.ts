/**
 * Vocabularies — the Neogranadina federation's document and place roles
 *
 * This data file holds the roles of one federation, Neogranadina: the
 * groups its document roles fall into, the roles a person or corporate
 * body takes in a description, and the roles a place takes in one.
 * Fisqua names none of these values; each federation defines its own,
 * and `scripts/commands/seed-federation-vocabulary.ts` seeds them into
 * `vocabulary_values` from a file such as this one, chosen with
 * `--set neogranadina-roles`.
 *
 * The codes, groups, positions and labels are the ones the
 * institution-records fill wrote on every federation from the constants
 * and the locale files (`scripts/lib/institution-records-fill.ts`), so a
 * plan against a federation the fill seeded finds every row unchanged.
 * Where a stored label differs from this file, the stored label is the
 * one in use, and this file is corrected to match it.
 *
 * What each part holds:
 *   - `kind`: `roles`; a relation set has the kind `relations`.
 *   - `existingGroups`: role groups the federation must already hold for
 *     the roles that name them; none here, as the file adds every group
 *     its roles name.
 *   - `groups`: each group's code, its position among the groups and its
 *     labels.
 *   - `entityRoles`: each role's code, its group, its position within
 *     that group and its labels.
 *   - `placeRoles`: each role's code, its position and its labels.
 *
 * Labels are in sentence case, Spanish and English.
 *
 * @version v0.9.0
 */

export interface RoleVocabularySet {
  kind: "roles";
  /** The set's name, as `--set` takes it. */
  name: string;
  existingGroups: string[];
  groups: Array<{ code: string; position: number; es: string; en: string }>;
  entityRoles: Array<{ code: string; group: string; position: number; es: string; en: string }>;
  placeRoles: Array<{ code: string; position: number; es: string; en: string }>;
}

export const NEOGRANADINA_ROLES: RoleVocabularySet = {
  kind: "roles",
  name: "neogranadina-roles",
  existingGroups: [],
  groups: [
    { code: "production", position: 1, es: "Producción y menciones", en: "Production & mentions" },
    { code: "correspondence", position: 2, es: "Correspondencia", en: "Correspondence" },
    { code: "notarial", position: 3, es: "Actuación notarial", en: "Notarial attestation" },
    { code: "legal", position: 4, es: "Procedimientos judiciales", en: "Legal proceedings" },
    { code: "family", position: 5, es: "Familia y herencia", en: "Family & inheritance" },
    { code: "transactions", position: 6, es: "Transacciones", en: "Transactions" },
    { code: "visual", position: 7, es: "Materiales visuales", en: "Visual materials" },
  ],
  entityRoles: [
    { code: "creator", group: "production", position: 1, es: "Creador", en: "Creator" },
    { code: "author", group: "production", position: 2, es: "Autor", en: "Author" },
    { code: "editor", group: "production", position: 3, es: "Editor", en: "Editor" },
    { code: "publisher", group: "production", position: 4, es: "Editor (publicación)", en: "Publisher" },
    { code: "mentioned", group: "production", position: 5, es: "Mencionado", en: "Mentioned" },
    { code: "subject", group: "production", position: 6, es: "Tema", en: "Subject" },
    { code: "official", group: "production", position: 7, es: "Funcionario", en: "Official" },
    { code: "sender", group: "correspondence", position: 1, es: "Remitente", en: "Sender" },
    { code: "recipient", group: "correspondence", position: 2, es: "Destinatario", en: "Recipient" },
    { code: "scribe", group: "notarial", position: 1, es: "Escribano", en: "Scribe" },
    { code: "witness", group: "notarial", position: 2, es: "Testigo", en: "Witness" },
    { code: "notary", group: "notarial", position: 3, es: "Notario", en: "Notary" },
    { code: "plaintiff", group: "legal", position: 1, es: "Demandante", en: "Plaintiff" },
    { code: "defendant", group: "legal", position: 2, es: "Demandado", en: "Defendant" },
    { code: "petitioner", group: "legal", position: 3, es: "Peticionario", en: "Petitioner" },
    { code: "judge", group: "legal", position: 4, es: "Juez", en: "Judge" },
    { code: "appellant", group: "legal", position: 5, es: "Apelante", en: "Appellant" },
    { code: "fiador", group: "legal", position: 6, es: "Fiador", en: "Surety" },
    { code: "apoderado", group: "legal", position: 7, es: "Apoderado", en: "Attorney-in-Fact" },
    { code: "victim", group: "legal", position: 8, es: "Víctima", en: "Victim" },
    { code: "heir", group: "family", position: 1, es: "Heredero", en: "Heir" },
    { code: "albacea", group: "family", position: 2, es: "Albacea", en: "Executor" },
    { code: "spouse", group: "family", position: 3, es: "Cónyuge", en: "Spouse" },
    { code: "grantor", group: "transactions", position: 1, es: "Otorgante", en: "Grantor" },
    { code: "donor", group: "transactions", position: 2, es: "Donante", en: "Donor" },
    { code: "seller", group: "transactions", position: 3, es: "Vendedor", en: "Seller" },
    { code: "buyer", group: "transactions", position: 4, es: "Comprador", en: "Buyer" },
    { code: "mortgagor", group: "transactions", position: 5, es: "Deudor hipotecario", en: "Mortgagor" },
    { code: "mortgagee", group: "transactions", position: 6, es: "Acreedor hipotecario", en: "Mortgagee" },
    { code: "creditor", group: "transactions", position: 7, es: "Acreedor", en: "Creditor" },
    { code: "debtor", group: "transactions", position: 8, es: "Deudor", en: "Debtor" },
    { code: "photographer", group: "visual", position: 1, es: "Fotógrafo", en: "Photographer" },
    { code: "artist", group: "visual", position: 2, es: "Artista", en: "Artist" },
  ],
  placeRoles: [
    { code: "created", position: 1, es: "Creado", en: "Created" },
    { code: "subject", position: 2, es: "Tema", en: "Subject" },
    { code: "mentioned", position: 3, es: "Mencionado", en: "Mentioned" },
    { code: "sent_from", position: 4, es: "Enviado desde", en: "Sent from" },
    { code: "sent_to", position: 5, es: "Recibido en", en: "Sent to" },
    { code: "published", position: 6, es: "Publicado", en: "Published" },
    { code: "venue", position: 7, es: "Lugar", en: "Venue" },
  ],
};

// @version v0.9.0
