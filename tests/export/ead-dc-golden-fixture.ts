/**
 * EAD3 and Dublin Core Golden Fixture
 *
 * This module deals with the small synthetic fonds whose EAD3 and Dublin
 * Core files are pinned byte for byte in `ead-dc-golden.ts`. The files
 * there were written by the single-string builders as they stood before
 * the publish steps began writing these documents a batch at a time, so
 * the comparison holds the batched path to the pre-refactor output, not
 * to itself.
 *
 * The fonds has a root, two series and six files, one of them
 * unpublished, ids out of insertion order, two repositories, and text
 * that needs escaping or is not ASCII: guillemets, an em dash, an
 * astral character, `&`, `<`, `>` and quotes. Every field the ISAD(G),
 * DACS and RAD profiles read is set on the root, and legacy ids include
 * one malformed entry the step drops. None of it is production data.
 *
 * `goldenRows` is in insertion order; the builders were given the
 * published rows in `id` order, the order the step writes them in.
 *
 * The first repository has every part of the attribution line (place,
 * credit statement, licence) and the old rights text, which no file
 * reads; the second has only its name and city. `GOLDEN_HOSTING` is the
 * federation's hosting statement, which both lines carry.
 *
 * @version v0.9.0
 */

export const GOLDEN_FONDS = "co-g-fondo";
export const GOLDEN_NOW = new Date("2026-10-31T12:00:00.000Z");
export const GOLDEN_CREATED = 1_700_000_000_000;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const GOLDEN_ROOT = uuid(100);

export const goldenRepositories = [
  {
    id: uuid(1),
    code: "co-g",
    name: "Archivo «Gómez» & Cía",
    city: "Popayán",
    region: "Cauca",
    country: "Colombia",
    manifestRights: "https://creativecommons.org/licenses/by/4.0/",
    creditStatementEs: "Digitalizado por el archivo.",
    creditStatementEn: "Digitized by the archive.",
    rightsText: "Uso libre — citar la fuente",
  },
  { id: uuid(2), code: "co-h", name: "Biblioteca Ñ", city: "Cali", rightsText: null },
];

/** The federation's hosting statement, part of every repository's attribution line. */
export const GOLDEN_HOSTING = {
  hostingStatementEs: "Alojado por la federación de prueba.",
  hostingStatementEn: "Hosted by the test federation.",
};

type GoldenRow = {
  id: string;
  parentId: string | null;
  repositoryId: string;
  descriptionLevel: "fonds" | "series" | "file" | "item";
  referenceCode: string;
  title: string;
  isPublished: boolean;
  dateExpression?: string | null;
  extent?: string | null;
  creatorDisplay?: string | null;
  scopeContent?: string | null;
  accessConditions?: string | null;
  language?: string | null;
  placeDisplay?: string | null;
  imprint?: string | null;
  legacyIds?: string;
  adminBiogHistory?: string | null;
  preferredCitation?: string | null;
  acquisitionInfo?: string | null;
  systemOfArrangement?: string | null;
  physicalCharacteristics?: string | null;
};

export const goldenRows: GoldenRow[] = [
  {
    id: GOLDEN_ROOT,
    parentId: null,
    repositoryId: uuid(1),
    descriptionLevel: "fonds",
    referenceCode: GOLDEN_FONDS,
    title: "Fondo Gómez — «Cabildo» 𝄞",
    isPublished: true,
    dateExpression: "1700-1810",
    extent: "3 cajas, 12 legajos",
    creatorDisplay: "Cabildo de Popayán",
    scopeContent: "Actas & cuentas del cabildo <sic>, \"originales\" y 'copias'.",
    accessConditions: "Consulta libre en sala",
    language: "spa",
    placeDisplay: "Popayán",
    legacyIds: JSON.stringify([{ provider: "ca", id: 7 }, { provider: "", id: "x" }]),
    adminBiogHistory: "El cabildo gobernó la ciudad desde 1537.",
    preferredCitation: "Archivo Gómez, Fondo Cabildo",
    acquisitionInfo: "Donación de la familia Gómez, 1950",
    systemOfArrangement: "Dos series por función",
    physicalCharacteristics: "Papel de hilo, tinta ferrogálica",
  },
  { id: uuid(103), parentId: GOLDEN_ROOT, repositoryId: uuid(1), descriptionLevel: "series", referenceCode: "co-g-s1", title: "Serie Actas", isPublished: true, dateExpression: "1700-1750" },
  { id: uuid(101), parentId: GOLDEN_ROOT, repositoryId: uuid(1), descriptionLevel: "series", referenceCode: "co-g-s2", title: "Serie Cuentas", isPublished: true },
  {
    id: uuid(106), parentId: uuid(103), repositoryId: uuid(1), descriptionLevel: "file", referenceCode: "co-g-s1-f1",
    title: "Acta del señor Muñoz — 1712", isPublished: true, scopeContent: "Elección de alcaldes & regidores.",
    dateExpression: "1712", creatorDisplay: "Escribano Pérez", language: "lat", extent: "4 folios",
    legacyIds: JSON.stringify([{ provider: "former-reference-code", id: "co-g-viejo-1" }, { bad: true }]),
  },
  {
    id: uuid(102), parentId: uuid(103), repositoryId: uuid(2), descriptionLevel: "item", referenceCode: "co-g-s1-f1-i1",
    title: "Carta «reservada» 𝄞", isPublished: true, scopeContent: null, placeDisplay: "Cali", imprint: "s. i.",
  },
  {
    id: uuid(105), parentId: uuid(101), repositoryId: uuid(1), descriptionLevel: "file", referenceCode: "co-g-s2-f1",
    title: "Cuentas de propios", isPublished: true, scopeContent: "Ingresos < egresos > nada", language: "spa",
  },
  {
    id: uuid(104), parentId: uuid(101), repositoryId: uuid(1), descriptionLevel: "file", referenceCode: "co-g-s2-f2",
    title: "Borrador sin publicar", isPublished: false,
  },
  {
    id: uuid(107), parentId: uuid(101), repositoryId: uuid(2), descriptionLevel: "file", referenceCode: "co-g-s2-f3",
    title: "Libro de cuentas Ñ", isPublished: true, dateExpression: "1790-1799", extent: "1 libro",
  },
];

// @version v0.9.0
