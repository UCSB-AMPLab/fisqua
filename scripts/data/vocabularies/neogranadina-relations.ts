/**
 * Vocabularies — the Neogranadina federation's relation vocabulary
 *
 * This data file holds the relation vocabulary of one federation,
 * Neogranadina: the role groups its relations fall into, the relation
 * roles themselves, the attributes a link may carry and the genders an
 * entity may be recorded with. Fisqua names none of these values; each
 * federation defines its own, and `scripts/commands/seed-federation-vocabulary.ts`
 * seeds them into `vocabulary_values` from a file such as this one.
 *
 * What each part holds:
 *   - `kind`: `relations`; a set of document and place roles has the
 *     kind `roles`.
 *   - `existingGroups`: role groups the federation already holds that
 *     this set refers to (here `legal`, which takes the guarantor and
 *     attorney relations). They are never written; the seed refuses a
 *     federation that does not hold them.
 *   - `groups`: the role groups this set adds, in the order they follow
 *     the federation's existing groups.
 *   - `relations`: each relation code, its group, its inverse (the code
 *     on the other side; the same code for a symmetric relation), its
 *     label in four forms per language (female, male, unrecorded when the
 *     person's gender is not recorded, and alone, with no name after it,
 *     given only where it differs from the unrecorded form) and the
 *     connector between the label and the other person's name.
 *   - `attributes`: the keys a link may carry, in order, each with the
 *     relation group whose presence on the same row hides it on Zasqua.
 *   - `genders`: the codes `entities.gender` takes.
 *
 * Group, attribute and gender labels are in sentence case, like every other
 * stored label. Relation forms and connectors are lowercase, because they are
 * joined into a phrase with the other person's name. Where a form is the same
 * for every gender it is written out in full, not abbreviated.
 *
 * @version v0.9.0
 */

export interface RelationVocabularyLabel {
  female: string;
  male: string;
  unrecorded: string;
  /** Only where it differs from the unrecorded form. */
  alone?: string;
  connector: string;
}

export interface RelationVocabularySet {
  kind: "relations";
  /** The set's name, as `--set` takes it. */
  name: string;
  existingGroups: string[];
  groups: Array<{ code: string; es: string; en: string }>;
  relations: Array<{ code: string; group: string; inverse: string; es: RelationVocabularyLabel; en: RelationVocabularyLabel }>;
  attributes: Array<{ code: string; es: string; en: string; hideWhenGroup?: string }>;
  genders: Array<{ code: string; es: string; en: string }>;
}

/** A relation whose label is one form for every gender. */
const same = (label: string, connector: string, alone?: string): RelationVocabularyLabel => ({
  female: label,
  male: label,
  unrecorded: label,
  ...(alone !== undefined ? { alone } : {}),
  connector,
});

const of = (female: string, male: string, unrecorded: string, connector: string, alone?: string): RelationVocabularyLabel => ({
  female,
  male,
  unrecorded,
  ...(alone !== undefined ? { alone } : {}),
  connector,
});

export const NEOGRANADINA_RELATIONS: RelationVocabularySet = {
  kind: "relations",
  name: "neogranadina-relations",
  existingGroups: ["legal"],
  groups: [
    { code: "kinship", es: "Parentesco", en: "Kinship" },
    { code: "executorship_guardianship", es: "Albaceazgo, tutela y curaduría", en: "Executorship, guardianship and curatorship" },
    { code: "enslavement", es: "Esclavización", en: "Enslavement" },
    { code: "enslaved_ties", es: "Vínculos entre personas esclavizadas", en: "Ties among enslaved people" },
  ],
  relations: [
    { code: "parent", group: "kinship", inverse: "child", es: of("madre", "padre", "madre o padre", "de"), en: of("mother", "father", "parent", "of") },
    { code: "child", group: "kinship", inverse: "parent", es: of("hija", "hijo", "hija o hijo", "de"), en: of("daughter", "son", "child", "of") },
    { code: "spouse", group: "kinship", inverse: "spouse", es: of("esposa", "esposo", "cónyuge", "de"), en: of("wife", "husband", "spouse", "of") },
    { code: "surviving_spouse", group: "kinship", inverse: "spouse", es: of("viuda", "viudo", "viuda o viudo", "de"), en: of("widow", "widower", "surviving spouse", "of") },
    { code: "sibling", group: "kinship", inverse: "sibling", es: of("hermana", "hermano", "hermana o hermano", "de"), en: of("sister", "brother", "sibling", "of") },
    { code: "grandparent", group: "kinship", inverse: "grandchild", es: of("abuela", "abuelo", "abuela o abuelo", "de"), en: of("grandmother", "grandfather", "grandparent", "of") },
    { code: "grandchild", group: "kinship", inverse: "grandparent", es: of("nieta", "nieto", "nieta o nieto", "de"), en: of("granddaughter", "grandson", "grandchild", "of") },
    { code: "parents_sibling", group: "kinship", inverse: "siblings_child", es: of("tía", "tío", "tía o tío", "de"), en: of("aunt", "uncle", "aunt or uncle", "of") },
    { code: "siblings_child", group: "kinship", inverse: "parents_sibling", es: of("sobrina", "sobrino", "sobrina o sobrino", "de"), en: of("niece", "nephew", "niece or nephew", "of") },
    { code: "cousin", group: "kinship", inverse: "cousin", es: of("prima", "primo", "prima o primo", "de"), en: same("cousin", "of") },
    { code: "parent_in_law", group: "kinship", inverse: "child_in_law", es: of("suegra", "suegro", "suegra o suegro", "de"), en: of("mother-in-law", "father-in-law", "parent-in-law", "of") },
    { code: "child_in_law", group: "kinship", inverse: "parent_in_law", es: of("nuera", "yerno", "nuera o yerno", "de"), en: of("daughter-in-law", "son-in-law", "child-in-law", "of") },
    { code: "sibling_in_law", group: "kinship", inverse: "sibling_in_law", es: of("cuñada", "cuñado", "cuñada o cuñado", "de"), en: of("sister-in-law", "brother-in-law", "sibling-in-law", "of") },
    { code: "relative", group: "kinship", inverse: "relative", es: same("pariente", "de"), en: same("relative", "of") },
    { code: "godparent", group: "kinship", inverse: "godchild", es: of("madrina", "padrino", "madrina o padrino", "de"), en: of("godmother", "godfather", "godparent", "of") },
    { code: "godchild", group: "kinship", inverse: "godparent", es: of("ahijada", "ahijado", "ahijada o ahijado", "de"), en: of("goddaughter", "godson", "godchild", "of") },
    { code: "co_parent", group: "kinship", inverse: "co_parent", es: of("comadre", "compadre", "comadre o compadre", "de"), en: of("comadre", "compadre", "comadre or compadre", "of") },
    { code: "albacea", group: "executorship_guardianship", inverse: "testator", es: same("albacea", "de"), en: same("executor", "of") },
    { code: "testator", group: "executorship_guardianship", inverse: "albacea", es: of("testadora", "testador", "testadora o testador", "de"), en: same("testator", "who appointed") },
    { code: "tutor", group: "executorship_guardianship", inverse: "ward", es: of("tutora", "tutor", "tutora o tutor", "de"), en: same("guardian", "of") },
    { code: "curador", group: "executorship_guardianship", inverse: "ward", es: of("curadora", "curador", "curadora o curador", "de"), en: same("curator", "of") },
    { code: "ward", group: "executorship_guardianship", inverse: "tutor", es: same("menor", "de", "menor bajo tutela o curaduría"), en: same("ward", "of", "minor under guardianship") },
    { code: "fiador", group: "legal", inverse: "guaranteed_party", es: of("fiadora", "fiador", "fiadora o fiador", "de"), en: same("guarantor", "for") },
    { code: "guaranteed_party", group: "legal", inverse: "fiador", es: of("fiada", "fiado", "fiada o fiado", "de", "persona con fiador"), en: same("guaranteed", "by", "person with a guarantor") },
    { code: "apoderado", group: "legal", inverse: "principal", es: of("apoderada", "apoderado", "apoderada o apoderado", "de"), en: same("attorney", "for") },
    { code: "principal", group: "legal", inverse: "apoderado", es: same("poderdante", "de"), en: same("represented", "by", "principal") },
    { code: "enslaver", group: "enslavement", inverse: "enslaved", es: of("esclavizadora", "esclavizador", "esclavizadora o esclavizador", "de"), en: same("enslaver", "of") },
    { code: "enslaved", group: "enslavement", inverse: "enslaver", es: of("esclavizada", "esclavizado", "persona esclavizada", "por"), en: same("enslaved", "by", "enslaved person") },
    { code: "sold_together", group: "enslaved_ties", inverse: "sold_together", es: same("en la misma venta", "que", "misma venta"), en: same("sold in the same sale", "as", "same sale") },
    { code: "donated_together", group: "enslaved_ties", inverse: "donated_together", es: same("en la misma donación", "que", "misma donación"), en: same("donated in the same donation", "as", "same donation") },
    { code: "mortgaged_together", group: "enslaved_ties", inverse: "mortgaged_together", es: same("en la misma hipoteca", "que", "misma hipoteca"), en: same("mortgaged in the same mortgage", "as", "same mortgage") },
    { code: "inherited_together", group: "enslaved_ties", inverse: "inherited_together", es: same("en la misma herencia", "que", "misma herencia"), en: same("inherited in the same inheritance", "as", "same inheritance") },
    { code: "transferred_together", group: "enslaved_ties", inverse: "transferred_together", es: same("en el mismo traspaso", "que", "mismo traspaso"), en: same("transferred in the same transfer", "as", "same transfer") },
  ],
  attributes: [
    { code: "office", es: "Cargo", en: "Office" },
    { code: "occupation", es: "Oficio o actividad", en: "Occupation" },
    { code: "condition", es: "Condición", en: "Condition", hideWhenGroup: "enslavement" },
    { code: "calidad", es: "Calidad", en: "Calidad" },
    { code: "ethnonym", es: "Etnónimo", en: "Ethnonym" },
    { code: "marital_status", es: "Estado civil", en: "Marital status" },
    { code: "residence", es: "Vecindad", en: "Residence" },
    { code: "origin", es: "Procedencia", en: "Origin" },
    { code: "age", es: "Edad", en: "Age" },
  ],
  genders: [
    { code: "female", es: "Mujer", en: "Woman" },
    { code: "male", es: "Hombre", en: "Man" },
  ],
};

// @version v0.9.0
