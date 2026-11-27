/**
 * Institution records — the values Neogranadina's instance holds today
 *
 * This module holds, as data, the values the Neogranadina instance
 * hard-codes today: in its theme, a display title, a Spanish subtitle and
 * a hero image for each of the five partner repositories, and in
 * `hugo.toml`, the name of its publisher. With them here,
 * `scripts/commands/fill-institution-records.ts` can write them into the
 * repository and federation records without reading the instance at run
 * time. Every value is verbatim and names its source: the file in
 * `juancobo/zasqua-neogranadina-dev`, the commit that last changed it, and
 * the line.
 *
 *   - `themes/neogranadina/layouts/repository/single.html` at 56ebcd4:
 *     display titles, subtitles and hero images (lines 30–52);
 *   - `themes/neogranadina/static/img/` at 56ebcd4: the hero files, with
 *     their size and SHA-256 as read on 2026-11-02;
 *   - `themes/neogranadina/layouts/index.html` at 3b98473: the order of
 *     the repository cards on the home page (line 57), as `homeOrder`,
 *     and the cards' "city, region" categories (lines 85–97);
 *   - `hugo.toml` at 9e607cb: the footer copyright and the METS and
 *     EAC-CPF publisher strings (lines 80–106).
 *
 * The publisher's contact email is a ruling of 2026-11-02; the funders,
 * the other names of co-ahjci and the federation's hosting statement
 * ("Alojado en Zasqua (zasqua.org)." / "Hosted on Zasqua (zasqua.org).",
 * which the attribution line uses as written) are rulings of 2026-11-03.
 *
 * Each repository's history, Spanish and English, is the text approved
 * on 2026-11-03: Markdown, two paragraphs (the institution, then the
 * digitization) joined by one blank line, stored as written, with the
 * pages it was taken from as its source. co-ahjci already holds a
 * longer history from an earlier fill; its entries name that text
 * byte for byte in `replaces`, and the fill writes the new text over the
 * held one only when the column holds exactly that text.
 *
 * Three changes of wording ruled on 2026-11-03, on attribution, replace
 * held values the same way, each entry naming the production text in
 * `replaces` and the ruling as its source:
 *
 *   - the subtitles of co-ahr, co-ahrb and co-cihjml say "digitalizados
 *     en alianza con Neogranadina en" in place of "digitalizados por
 *     Neogranadina en", the rest of each kept as the theme has it;
 *   - pe-bn's credit statement, Spanish and English, names the project
 *     "Narra la Independencia desde tu pueblo, tu distrito o tu ciudad",
 *     as the subtitle does, without "del Perú"; a ruling of 2026-11-06
 *     names it the same way in pe-bn's history, replaced in the same way;
 *   - co-cihjml's `rights_text` names the Centro de Investigaciones
 *     Históricas José María Arboleda Llorente in full in place of
 *     "CIHJML"; the reproduction sentence cut from it follows.
 *
 * No other value replaces a held one.
 *
 * Each repository's credit statement, Spanish and English, says who
 * digitized the materials, with whom and with whose support. It is
 * plain text, approved on 2026-11-03 from the Neogranadina project pages
 * and the EAP1477 project page, and the attribution line uses it as
 * written.
 *
 * The repository facts — short names, other names, institution type,
 * address, email, website, telephone, opening times and access
 * conditions — were approved on 2026-11-03. Each names its source in one
 * of three ways: the institution's own web page, by URL, with a verbatim
 * quote where one was taken ("…") and otherwise a note in parentheses on
 * what the page gives (its publication date, the branch, where a quote
 * was cut); the page of the Neogranadina project with that repository,
 * by URL and quote; or, for a website, the institution's own site. The
 * pages are not fetched. A fact not approved is not here: co-ahr's
 * opening times and access conditions wait for confirmation, and co-ahjci
 * has none. BNP's access conditions are two paragraphs, separated by one
 * blank line, stored as written.
 *
 * The Spanish reproduction-services sentence is read from D1 instead,
 * cut from `rights_text` (co-cihjml's as ruled above), and named here
 * only by rule.
 *
 * The English text approved on 2026-11-06 is held as written, with that
 * approval as its source: the subtitle and the reproduction sentence of
 * every repository, co-cihjml's and BNP's access conditions (BNP's in
 * two paragraphs separated by one blank line, as the Spanish), and BNP's
 * opening times. Each is written only where its column is empty.
 *
 * A funder names its source in one of two ways. A D1 funder (`kind:
 * "d1"`) names a column and evidence strings that must still appear
 * verbatim in that column before its row is written. A web funder
 * (`kind: "web"`) names the page it is taken from and a verbatim quote
 * from that page; the page is not fetched, and both are copied into the
 * report.
 *
 * A repository's funder list, when it has one, is the whole set: a held
 * funder whose name is not in the list is deleted, a listed funder not
 * held is inserted at its place in the list, and a held funder with a
 * listed name is left as it is. A repository with no `funders` entry
 * keeps whatever funders it holds.
 *
 * A region is set only where the subtitle names one between the city
 * and the country, or where a home-page card category names it after
 * the city. The English text is the histories, the credit statements
 * and the text approved on 2026-11-06; no other `_en` value is set.
 *
 * @version v0.9.0
 */

export interface Sourced<T> {
  value: T;
  source: string;
}

/**
 * A sourced value that may replace one exact previous text: the fill
 * writes `value` over a held value only when it equals `replaces` byte
 * for byte.
 */
export interface Replacing<T> extends Sourced<T> {
  replaces?: T;
}

export interface HeroSource {
  /** Path in the instance repository. */
  path: string;
  /** The path the template names. */
  templatePath: string;
  ext: string;
  size: number;
  sha256: string;
  source: string;
}

interface FunderValues {
  name: string;
  programme: string | null;
  projectId: string | null;
  url: string | null;
}

/** A funder named in a repository's own text in D1. */
export interface D1FunderSource extends FunderValues {
  kind: "d1";
  /** The D1 column whose text must still contain every `evidence` string. */
  column: "attribution_en" | "attribution_es";
  evidence: string[];
  source: string;
}

/** A funder named on a web page; the page is not fetched. */
export interface WebFunderSource extends FunderValues {
  kind: "web";
  sourceUrl: string;
  /** Verbatim from the page at `sourceUrl`. */
  quote: string;
  ruling: string;
}

export type FunderSource = D1FunderSource | WebFunderSource;

export interface RepositorySource {
  displayTitle: Sourced<string>;
  subtitle: Replacing<string>;
  subtitleEn?: Sourced<string>;
  region?: Sourced<string>;
  /** Position of the repository's card on the home page, from 1. */
  homeOrder: Sourced<number>;
  hero: HeroSource;
  /** The repository's history, Markdown, Spanish and English. */
  historyEs?: Replacing<string>;
  historyEn?: Replacing<string>;
  /** Who digitized the materials, with whom and with whose support; plain text, used as written in the attribution line. */
  creditStatementEs?: Replacing<string>;
  creditStatementEn?: Replacing<string>;
  /** Other names of the repository, written as a JSON list. */
  otherNames?: Sourced<string[]>;
  shortName?: Sourced<string>;
  institutionType?: Sourced<string>;
  address?: Sourced<string>;
  email?: Sourced<string>;
  website?: Sourced<string>;
  telephone?: Sourced<string>;
  openingTimesEs?: Sourced<string>;
  openingTimesEn?: Sourced<string>;
  /** Plain text or Markdown paragraphs. */
  accessConditionsEs?: Sourced<string>;
  accessConditionsEn?: Sourced<string>;
  /** The English reproduction sentence; the Spanish one is cut from `rightsText`. */
  reproductionServicesEn?: Sourced<string>;
  /** The images' rights text, in full; the reproduction sentence is cut from it. */
  rightsText?: Replacing<string>;
  /** The repository's funders, in order; when absent, held funders are left alone. */
  funders?: FunderSource[];
}

export interface FederationNote {
  setting: string;
  value: string;
  source: string;
  /** The column it maps to, or null when none does. */
  column: string | null;
  note: string;
}

export interface InstitutionSource {
  federation: string;
  /** Values of the federation's publisher record; each is written only where the column is null. */
  publisher: {
    publisherEmail?: Sourced<string>;
    /** Where the federation's materials are hosted, used as written in the attribution line. */
    hostingStatementEs?: Sourced<string>;
    hostingStatementEn?: Sourced<string>;
  };
  repositories: Record<string, RepositorySource>;
  reproductionServices: {
    column: "rights_text";
    /** The text that precedes the sentence; it is not copied. */
    prefix: string;
    /** The sentence copied must begin with this. */
    sentenceStart: string;
    source: string;
  };
  federationNotes: FederationNote[];
}

const TEMPLATE = "zasqua-neogranadina-dev themes/neogranadina/layouts/repository/single.html @56ebcd4";
const IMG = "themes/neogranadina/static/img";
const INDEX = "zasqua-neogranadina-dev themes/neogranadina/layouts/index.html @3b98473";
const HOME = `${INDEX}:57`;
const HUGO = "zasqua-neogranadina-dev hugo.toml @9e607cb";
const RULING = "ruling 2026-11-03";
/** The wording rulings of 2026-11-03, on attribution. */
const WORDING = `${RULING}, on attribution`;
const FUNDERS_CONFIRMED = "confirmed as funders 2026-11-03";
const CREDIT = "approved text 2026-11-03, from neogranadina.org project pages and eap.bl.uk/project/EAP1477";
const APPROVED = "text approved 2026-11-03";
/** The English subtitles, reproduction sentences, access conditions and opening times. */
const ENGLISH = "English text approved 2026-11-06";
const EAP_PROJECT = "https://eap.bl.uk/project/EAP1477";
const EAP_COLLECTION = "https://eap.bl.uk/collection/EAP1477-1";
const AHRB_PAGE = "https://neogranadina.org/proyectos/archivo-historico-regional-de-boyaca/";
const AHR_PAGE = "https://neogranadina.org/proyectos/archivo-historico-de-rionegro/";
const RIONEGRO_AHR = "https://rionegro.gov.co/publicaciones/539/archivo-historico-de-rionegro/";
const ACC_PAGE = "https://neogranadina.org/proyectos/archivo-central-del-cauca/";
const UNICAUCA_AH = "https://www.unicauca.edu.co/vicerrectoria-academica/facultad-de-ciencias-humanas-y-sociales/archivo-historico/";
const BNP_ABOUT = "https://www.bnp.gob.pe/nosotros/quienes-somos/";
const BNP_HOURS = "https://www.bnp.gob.pe/horarios-locales/";
const NARRA_PAGE = "https://neogranadina.org/proyectos/narra/";

/**
 * The history co-ahjci holds from the earlier fill, byte for byte (source:
 * https://eap.bl.uk/collection/EAP1477-1, custodial history and
 * arrangement, and https://eap.bl.uk/project/EAP1477). The shorter text
 * approved on 2026-11-03 replaces it only where the column still holds
 * exactly this.
 */
const AHJCI_PREVIOUS_HISTORY_ES =
  "Los expedientes de este archivo los produjo el mismo Juzgado del Circuito de Istmina, que todavía los custodia. En la segunda mitad del siglo XIX, el juzgado se llamaba Juzgado del Distrito de San Juan y tenía su sede en Nóvita; era un juzgado de primera instancia y dependía de un tribunal superior con sede en Buga, creado en 1849. En la primera década del siglo XX se trasladó a Istmina, pasó a llamarse Juzgado del Circuito de Istmina y llevó consigo parte de su archivo. Hoy varios juzgados del circuito y municipales que funcionan en el palacio de justicia de Istmina comparten la responsabilidad del archivo.\n\n" +
  "Los expedientes estuvieron amontonados en sacos en el palacio de justicia, sin clasificar, hasta que entre 2021 y 2023 Daniel Varela y Angélica Agualimpia, con permiso del juzgado, los clasificaron por tema y por año en dos series, que hoy ocupan 37 cajas. En 2023 la colección se digitalizó con el proyecto piloto EAP1477, del Endangered Archives Programme de la British Library. Lo dirigió Ann Farnsworth-Alvear, de la Universidad de Pensilvania, en alianza con la Universidad de Michigan, la Fundación Muntú Bantú y la Fundación Histórica Neogranadina, que participó como socia archivística.";
const AHJCI_PREVIOUS_HISTORY_EN =
  "The Circuit Court of Istmina produced the files in this archive and still holds them. In the second half of the nineteenth century the court was the San Juan District Court (Juzgado del Distrito de San Juan), seated in Nóvita; it was a court of first instance under a higher court in Buga created in 1849. In the first decade of the twentieth century it moved to Istmina, took the name Circuit Court of Istmina, and took part of its archive with it. Today several circuit and municipal courts in the Istmina courthouse share responsibility for the archive.\n\n" +
  "The files lay in sacks in the courthouse, unsorted, until 2021–2023, when Daniel Varela and Angélica Agualimpia, with the court's permission, sorted them by subject and year into two series, now in 37 boxes. In 2023 the collection was digitized in the pilot project EAP1477 of the British Library's Endangered Archives Programme, led by Ann Farnsworth-Alvear of the University of Pennsylvania with the University of Michigan, Fundación Muntú Bantú and Fundación Histórica Neogranadina, its archival partner.";

export const NEOGRANADINA: InstitutionSource = {
  federation: "neogranadina",
  publisher: {
    publisherEmail: { value: "contacto@neogranadina.org", source: "ruling 2026-11-02" },
    hostingStatementEs: { value: "Alojado en Zasqua (zasqua.org).", source: RULING },
    hostingStatementEn: { value: "Hosted on Zasqua (zasqua.org).", source: RULING },
  },
  repositories: {
    "pe-bn": {
      creditStatementEs: {
        value:
          "Digitalizado por la Biblioteca Nacional del Perú. Neogranadina dirigió la catalogación colaborativa de la colección y la publicó en línea, en el marco del proyecto \"Narra la Independencia desde tu pueblo, tu distrito o tu ciudad\", que contó con el apoyo de la Universidad de California, Santa Bárbara; del Instituto Francés de Estudios Andinos; del Instituto de Estudios Peruanos; de la Universidad de París III Sorbonne-Nouvelle; de la Universidad Nacional San Cristóbal de Huamanga, y de la Universidad Nacional Mayor de San Marcos.",
        replaces:
          "Digitalizado por la Biblioteca Nacional del Perú. Neogranadina dirigió la catalogación colaborativa de la colección y la publicó en línea, en el marco del proyecto \"Narra la Independencia del Perú desde tu pueblo, tu distrito o tu ciudad\", que contó con el apoyo de la Universidad de California, Santa Bárbara; del Instituto Francés de Estudios Andinos; del Instituto de Estudios Peruanos; de la Universidad de París III Sorbonne-Nouvelle; de la Universidad Nacional San Cristóbal de Huamanga, y de la Universidad Nacional Mayor de San Marcos.",
        source: `${WORDING} (the project named as in the subtitle); the rest ${CREDIT}`,
      },
      creditStatementEn: {
        value:
          "Digitized by the Biblioteca Nacional del Perú. Neogranadina led the collaborative cataloging of the collection and published it online, as part of the project \"Narra la Independencia desde tu pueblo, tu distrito o tu ciudad\", which was supported by the University of California, Santa Barbara; the Instituto Francés de Estudios Andinos; the Instituto de Estudios Peruanos; the Université Paris III Sorbonne-Nouvelle; the Universidad Nacional San Cristóbal de Huamanga; and the Universidad Nacional Mayor de San Marcos.",
        replaces:
          "Digitized by the Biblioteca Nacional del Perú. Neogranadina led the collaborative cataloging of the collection and published it online, as part of the project \"Narra la Independencia del Perú desde tu pueblo, tu distrito o tu ciudad\", which was supported by the University of California, Santa Barbara; the Instituto Francés de Estudios Andinos; the Instituto de Estudios Peruanos; the Université Paris III Sorbonne-Nouvelle; the Universidad Nacional San Cristóbal de Huamanga; and the Universidad Nacional Mayor de San Marcos.",
        source: `${WORDING} (the project named as in the subtitle); the rest ${CREDIT}`,
      },
      historyEs: {
        value:
          "La Biblioteca Nacional del Perú es un organismo público ejecutor adscrito al Ministerio de Cultura. Se rige por la Ley 30570 y es el ente rector del Sistema Nacional de Bibliotecas. Es el centro depositario del patrimonio cultural bibliográfico, digital, documental, fílmico, fotográfico y musical del Perú.\n\nLa Biblioteca digitalizó la totalidad de la Colección documental del sesquicentenario de la independencia del Perú, que reúne documentos de los siglos XVIII al XX: legislación, informes oficiales, periódicos, manifiestos, correspondencia, memorias, relatos y obras literarias. En el proyecto \"Narra la Independencia desde tu pueblo, tu distrito o tu ciudad\", Neogranadina dirigió la catalogación colaborativa de la colección, con más de 30 voluntarios y estudiantes, e integró los 14.374 documentos a su plataforma en línea.",
        replaces:
          "La Biblioteca Nacional del Perú es un organismo público ejecutor adscrito al Ministerio de Cultura. Se rige por la Ley 30570 y es el ente rector del Sistema Nacional de Bibliotecas. Es el centro depositario del patrimonio cultural bibliográfico, digital, documental, fílmico, fotográfico y musical del Perú.\n\nLa Biblioteca digitalizó la totalidad de la Colección documental del sesquicentenario de la independencia del Perú, que reúne documentos de los siglos XVIII al XX: legislación, informes oficiales, periódicos, manifiestos, correspondencia, memorias, relatos y obras literarias. En el proyecto \"Narra la Independencia del Perú desde tu pueblo, tu distrito o tu ciudad\", Neogranadina dirigió la catalogación colaborativa de la colección, con más de 30 voluntarios y estudiantes, e integró los 14.374 documentos a su plataforma en línea.",
        source: `ruling 2026-11-06 (the project named as in the subtitle); the rest https://www.bnp.gob.pe/institucion/quienes-somos/; https://neogranadina.org/proyectos/narra/; ${APPROVED}`,
      },
      historyEn: {
        value:
          "The Biblioteca Nacional del Perú is a public executing agency attached to the Ministry of Culture. It is governed by Law 30570 and heads the National Library System. It is the repository of Peru's bibliographic, digital, documentary, film, photographic and musical cultural heritage.\n\nThe Library digitized the whole of the Colección documental del sesquicentenario de la independencia del Perú, which gathers records from the eighteenth to the twentieth century: legislation, official reports, newspapers, manifestos, correspondence, memoirs, accounts and literary works. In the project \"Narra la Independencia desde tu pueblo, tu distrito o tu ciudad\", Neogranadina led the collaborative cataloging of the collection, with more than 30 volunteers and students, and added its 14,374 documents to its online platform.",
        replaces:
          "The Biblioteca Nacional del Perú is a public executing agency attached to the Ministry of Culture. It is governed by Law 30570 and heads the National Library System. It is the repository of Peru's bibliographic, digital, documentary, film, photographic and musical cultural heritage.\n\nThe Library digitized the whole of the Colección documental del sesquicentenario de la independencia del Perú, which gathers records from the eighteenth to the twentieth century: legislation, official reports, newspapers, manifestos, correspondence, memoirs, accounts and literary works. In the project \"Narra la Independencia del Perú desde tu pueblo, tu distrito o tu ciudad\", Neogranadina led the collaborative cataloging of the collection, with more than 30 volunteers and students, and added its 14,374 documents to its online platform.",
        source: `ruling 2026-11-06 (the project named as in the subtitle); the rest https://www.bnp.gob.pe/institucion/quienes-somos/; https://neogranadina.org/proyectos/narra/; ${APPROVED}`,
      },
      funders: [
        { kind: "web", name: "Universidad de California, Santa Bárbara", programme: null, projectId: null, url: null, sourceUrl: NARRA_PAGE, quote: "PATROCINADORES", ruling: FUNDERS_CONFIRMED },
        { kind: "web", name: "Instituto Francés de Estudios Andinos", programme: null, projectId: null, url: null, sourceUrl: NARRA_PAGE, quote: "PATROCINADORES", ruling: FUNDERS_CONFIRMED },
        { kind: "web", name: "Instituto de Estudios Peruanos", programme: null, projectId: null, url: null, sourceUrl: NARRA_PAGE, quote: "PATROCINADORES", ruling: FUNDERS_CONFIRMED },
        { kind: "web", name: "Universidad de París III Sorbonne-Nouvelle", programme: null, projectId: null, url: null, sourceUrl: NARRA_PAGE, quote: "PATROCINADORES", ruling: FUNDERS_CONFIRMED },
        { kind: "web", name: "Universidad Nacional San Cristóbal de Huamanga", programme: null, projectId: null, url: null, sourceUrl: NARRA_PAGE, quote: "PATROCINADORES", ruling: FUNDERS_CONFIRMED },
        { kind: "web", name: "Universidad Nacional Mayor de San Marcos", programme: null, projectId: null, url: null, sourceUrl: NARRA_PAGE, quote: "PATROCINADORES", ruling: FUNDERS_CONFIRMED },
      ],
      homeOrder: { value: 1, source: HOME },
      subtitleEn: {
        value: "Digital edition of the Colección documental de la Independencia del Perú, created for the public history project Narra la Independencia desde tu pueblo, tu distrito o tu ciudad.",
        source: ENGLISH,
      },
      reproductionServicesEn: {
        value: "For reproduction rights for publications, please contact the Biblioteca Nacional del Perú.",
        source: ENGLISH,
      },
      openingTimesEn: {
        value: "Monday to Saturday: 8:30 a.m. – 8:00 p.m.",
        source: ENGLISH,
      },
      accessConditionsEn: {
        value:
          "Visit the Library during opening hours and go to the User Services Room with your national identity document (DNI).\n\n" +
          "Researchers: go to the User Services Room with your DNI and a letter of introduction from your university or workplace, on letterhead and signed, vouching for you as a researcher.",
        source: ENGLISH,
      },
      displayTitle: { value: "Narra la Independencia", source: `${TEMPLATE}:30` },
      subtitle: {
        value:
          "Edición digital de la Colección documental de la Independencia del Perú, creada para el proyecto de historia pública Narra la Independencia desde tu pueblo, tu distrito o tu ciudad.",
        source: `${TEMPLATE}:31`,
      },
      hero: {
        path: `${IMG}/narra.jpg`,
        templatePath: "/img/narra.jpg",
        ext: "jpg",
        size: 138735,
        sha256: "be7205b33a376be5260bce13e7db8130d24be43b05c7e11b21bd96f6d15ae4f8",
        source: `${TEMPLATE}:32`,
      },
      shortName: { value: "BNP", source: `${BNP_ABOUT} ("La Biblioteca Nacional del Perú (BNP)")` },
      institutionType: {
        value: "organismo público ejecutor adscrito al Ministerio de Cultura",
        source:
          `${BNP_ABOUT} ("un organismo público ejecutor, con autonomía técnica, administrativa y económica, ` +
          `adscrito al Ministerio de Cultura (MC)")`,
      },
      address: { value: "Av. De La Poesía 160, San Borja", source: BNP_HOURS },
      telephone: { value: "(511) 513-6900 - Anexo 7000", source: BNP_HOURS },
      website: { value: "https://www.bnp.gob.pe", source: "https://www.bnp.gob.pe (the institution's own site)" },
      openingTimesEs: { value: "Lunes a Sábado: 8:30 a.m. - 8:00 p.m.", source: `${BNP_HOURS} (sede San Borja)` },
      accessConditionsEs: {
        value:
          "Solo necesita acercarse a nuestra sede en horario de atención y dirigirse a la Sala de Atención al Usuario portando su Documento Nacional de Identidad (DNI).\n\n" +
          "Usuario investigador: Debe apersonarse a la Sala de Atención al Usuario portando su DNI y una carta de presentación de su centro de estudios o centro laboral, membretada y firmada, que lo avale como investigador.",
        source: "https://www.bnp.gob.pe/?p=9109",
      },
    },
    "co-ahr": {
      creditStatementEs: {
        value:
          "Digitalizado en alianza con Neogranadina, con el apoyo de la Alcaldía de Rionegro.",
        source: CREDIT,
      },
      creditStatementEn: {
        value:
          "Digitized in partnership with Neogranadina, with support from the Alcaldía de Rionegro.",
        source: CREDIT,
      },
      historyEs: {
        value:
          "El Archivo Histórico de Rionegro conserva documentos de 1649 a 1967 sobre la localidad y el Oriente Antioqueño. Tiene su origen en el archivo del cabildo, organizado en 1786 con el traslado de la ciudad de Arma a Rionegro. En la década de 1970 lo trasladaron al Museo Histórico Casa de la Convención, donde se encuentra hoy. Entre finales de los años ochenta y comienzos de los noventa, la Fundación Antioqueña para los Estudios Sociales lo organizó en cuatro fondos. El Concejo Municipal lo creó como institución en 1994, mediante el Acuerdo 073, y en 2020 el Archivo General de la Nación lo declaró Bien de Interés Cultural de Carácter Documental Archivístico del ámbito nacional. Hoy lo custodia la Subsecretaría de Cultura del municipio.\n\nDesde 2022, el archivo trabaja en alianza con Neogranadina para digitalizar y publicar en acceso abierto todas sus colecciones manuscritas y de prensa. El equipo del archivo ya digitalizó todo el fondo Notarial.",
        source: `https://rionegro.gov.co/publicaciones/539/archivo-historico-de-rionegro/; https://neogranadina.org/proyectos/archivo-historico-de-rionegro/; ${APPROVED}`,
      },
      historyEn: {
        value:
          "The Archivo Histórico de Rionegro holds records from 1649 to 1967 on the town and the east of Antioquia. It originated in the town council's archive, organized in 1786 when the city of Arma was moved to Rionegro. In the 1970s it was moved to the Museo Histórico Casa de la Convención, where it remains. Between the late 1980s and the early 1990s, the Fundación Antioqueña para los Estudios Sociales arranged it in four fonds. The municipal council established it as an institution in 1994, by Acuerdo 073, and in 2020 the Archivo General de la Nación declared it a Bien de Interés Cultural de Carácter Documental Archivístico of national scope. Today the municipality's Subsecretaría de Cultura holds it.\n\nSince 2022 the archive has worked in partnership with Neogranadina to digitize and publish in open access all its manuscript and newspaper collections. The archive's team has already digitized the whole Notarial fonds.",
        source: `https://rionegro.gov.co/publicaciones/539/archivo-historico-de-rionegro/; https://neogranadina.org/proyectos/archivo-historico-de-rionegro/; ${APPROVED}`,
      },
      homeOrder: { value: 3, source: HOME },
      subtitleEn: {
        value: "Catalogs and materials digitized in partnership with Neogranadina at the Archivo Histórico de Rionegro, Antioquia, Colombia.",
        source: ENGLISH,
      },
      reproductionServicesEn: {
        value: "For reproduction rights for publications, please contact the Archivo Histórico de Rionegro.",
        source: ENGLISH,
      },
      displayTitle: { value: "Archivo Histórico de Rionegro", source: `${TEMPLATE}:35` },
      subtitle: {
        value:
          "Catálogos y materiales digitalizados en alianza con Neogranadina en el Archivo Histórico de Rionegro, Antioquia, Colombia.",
        replaces:
          "Catálogos y materiales digitalizados por Neogranadina en el Archivo Histórico de Rionegro, Antioquia, Colombia.",
        source: `${WORDING} ("digitalizados en alianza con Neogranadina en"); the rest from ${TEMPLATE}:36`,
      },
      region: { value: "Antioquia", source: `${TEMPLATE}:36 ("… de Rionegro, Antioquia, Colombia.")` },
      hero: {
        path: `${IMG}/AHR_front.jpg`,
        templatePath: "/img/AHR_front.jpg",
        ext: "jpg",
        size: 286263,
        sha256: "7c5fb4f4f9cc05cd66a2ec4c835621cf6590aa21ffb9ff3da1775f370cc45da1",
        source: `${TEMPLATE}:37`,
      },
      shortName: { value: "AHR", source: `${RIONEGRO_AHR} ("El Archivo Histórico de Rionegro (AHR)")` },
      website: { value: RIONEGRO_AHR, source: `${RIONEGRO_AHR} (page itself, published 26/06/2024)` },
      funders: [
        { kind: "web", name: "Alcaldía de Rionegro", programme: null, projectId: null, url: null, sourceUrl: AHR_PAGE, quote: "Con el apoyo de", ruling: RULING },
      ],
    },
    "co-ahrb": {
      creditStatementEs: {
        value:
          "Digitalizado en alianza con Neogranadina, con el apoyo de la Universidad de California, Santa Bárbara, y del Yale University Library Digital Humanities Laboratory.",
        source: CREDIT,
      },
      creditStatementEn: {
        value:
          "Digitized in partnership with Neogranadina, with support from the University of California, Santa Barbara, and the Yale University Library Digital Humanities Laboratory.",
        source: CREDIT,
      },
      historyEs: {
        value:
          "El Archivo Histórico Regional de Boyacá, en Tunja, custodia una de las colecciones de documentos administrativos y notariales coloniales más completas de América Latina.\n\nEntre 2015 y 2018, el archivo digitalizó, en alianza con Neogranadina, más de 580 legajos, que suman unas 420.000 imágenes. Neogranadina diseñó e instaló el escáner y formó a un operario para manejarlo. Como la mayor parte del material carecía de descripciones archivísticas, se emprendió un programa de catalogación colaborativa, y los catálogos, los metadatos y las imágenes se publican en línea.",
        source: `https://neogranadina.org/proyectos/archivo-historico-regional-de-boyaca/; ${APPROVED}`,
      },
      historyEn: {
        value:
          "The Archivo Histórico Regional de Boyacá, in Tunja, holds one of the most complete collections of colonial administrative and notarial records in Latin America.\n\nBetween 2015 and 2018 the archive digitized, in partnership with Neogranadina, more than 580 bundles, some 420,000 images. Neogranadina designed and installed the scanner and trained an operator to run it. As most of the material had no archival descriptions, a collaborative cataloging program was undertaken, and the catalogs, metadata and images are published online.",
        source: `https://neogranadina.org/proyectos/archivo-historico-regional-de-boyaca/; ${APPROVED}`,
      },
      homeOrder: { value: 4, source: HOME },
      subtitleEn: {
        value: "Materials digitized in partnership with Neogranadina at the Archivo Histórico Regional de Boyacá, Tunja, Colombia.",
        source: ENGLISH,
      },
      reproductionServicesEn: {
        value: "For reproduction rights for publications, please contact the Archivo Histórico Regional de Boyacá.",
        source: ENGLISH,
      },
      region: { value: "Boyacá", source: `${INDEX}:91 ("Tunja, Boyacá")` },
      displayTitle: { value: "Archivo Histórico Regional de Boyacá", source: `${TEMPLATE}:40` },
      subtitle: {
        value:
          "Materiales digitalizados en alianza con Neogranadina en el Archivo Histórico Regional de Boyacá, Tunja, Colombia.",
        replaces:
          "Materiales digitalizados por Neogranadina en el Archivo Histórico Regional de Boyacá, Tunja, Colombia.",
        source: `${WORDING} ("digitalizados en alianza con Neogranadina en"); the rest from ${TEMPLATE}:41`,
      },
      hero: {
        path: `${IMG}/AHRB_front.jpg`,
        templatePath: "/img/AHRB_front.jpg",
        ext: "jpg",
        size: 295440,
        sha256: "01f861b2b031fccf1f0aac36fbed259b8b7a284e0f43af9d3e2856333fafdbf0",
        source: `${TEMPLATE}:42`,
      },
      shortName: { value: "AHRB", source: `${AHRB_PAGE} ("La alianza entre Neogranadina y el AHRB")` },
      funders: [
        { kind: "web", name: "University of California, Santa Barbara", programme: null, projectId: null, url: null, sourceUrl: AHRB_PAGE, quote: "Con el apoyo de", ruling: RULING },
        { kind: "web", name: "Yale University Library Digital Humanities Laboratory", programme: null, projectId: null, url: null, sourceUrl: AHRB_PAGE, quote: "Con el apoyo de", ruling: RULING },
      ],
    },
    "co-cihjml": {
      creditStatementEs: {
        value:
          "Digitalizado en alianza con Neogranadina.",
        source: CREDIT,
      },
      creditStatementEn: {
        value:
          "Digitized in partnership with Neogranadina.",
        source: CREDIT,
      },
      historyEs: {
        value:
          "El Centro de Investigaciones Históricas José María Arboleda Llorente, también conocido por su antiguo nombre, Archivo Central del Cauca, se constituyó en 1970 y está adscrito a la Facultad de Ciencias Humanas y Sociales de la Universidad del Cauca, en Popayán. Custodia una de las colecciones documentales más ricas de Colombia. Entre los siglos XVI y XIX, Popayán fue un núcleo administrativo importante en la consolidación del imperio español en el norte de Suramérica.\n\nEntre 2015 y 2019, el Centro digitalizó parte de su colección en alianza con Neogranadina, que diseñó e instaló el escáner y formó a un operario para manejarlo. Hoy pueden consultarse en línea más de 1.800 documentos digitalizados. Además, se sistematizaron y publicaron en línea 26.343 registros de catálogo.",
        source: `https://neogranadina.org/proyectos/archivo-central-del-cauca/; https://www.unicauca.edu.co/vicerrectoria-academica/facultad-de-ciencias-humanas-y-sociales/archivo-historico/; ${APPROVED}`,
      },
      historyEn: {
        value:
          "The Centro de Investigaciones Históricas José María Arboleda Llorente, also known by its former name, Archivo Central del Cauca, was established in 1970 and belongs to the Facultad de Ciencias Humanas y Sociales of the Universidad del Cauca, in Popayán. It holds one of the richest documentary collections in Colombia. Between the sixteenth and nineteenth centuries, Popayán was an important administrative center in the consolidation of the Spanish empire in northern South America.\n\nBetween 2015 and 2019 the Centro digitized part of its collection in partnership with Neogranadina, which designed and installed the scanner and trained an operator to run it. More than 1,800 digitized documents can now be consulted online, and 26,343 catalog records were systematized and published online.",
        source: `https://neogranadina.org/proyectos/archivo-central-del-cauca/; https://www.unicauca.edu.co/vicerrectoria-academica/facultad-de-ciencias-humanas-y-sociales/archivo-historico/; ${APPROVED}`,
      },
      funders: [
        { kind: "web", name: "Universidad del Cauca", programme: null, projectId: null, url: null, sourceUrl: ACC_PAGE, quote: "Con el apoyo de", ruling: FUNDERS_CONFIRMED },
        { kind: "web", name: "Fundación Histórica Neogranadina", programme: null, projectId: null, url: null, sourceUrl: ACC_PAGE, quote: "Con el apoyo de", ruling: FUNDERS_CONFIRMED },
      ],
      homeOrder: { value: 5, source: HOME },
      subtitleEn: {
        value: "Catalogs and materials digitized in partnership with Neogranadina in the Antiguo Archivo Central del Cauca fonds of the Centro de Investigaciones Históricas José María Arboleda Llorente, Popayán, Colombia.",
        source: ENGLISH,
      },
      reproductionServicesEn: {
        value: "For reproduction rights for publications, please contact the Centro de Investigaciones Históricas José María Arboleda Llorente, Universidad del Cauca.",
        source: ENGLISH,
      },
      accessConditionsEn: {
        value: "Readers must first fill in the registration form and accept the internal regulations.",
        source: ENGLISH,
      },
      region: { value: "Cauca", source: `${INDEX}:97 ("Popayán, Cauca")` },
      displayTitle: { value: "Antiguo Archivo Central del Cauca", source: `${TEMPLATE}:45` },
      subtitle: {
        value:
          "Catálogos y materiales digitalizados en alianza con Neogranadina en el fondo Antiguo Archivo Central del Cauca, del Centro de Investigaciones Históricas José María Arboleda Llorente, Popayán, Colombia.",
        replaces:
          "Catálogos y materiales digitalizados por Neogranadina en el fondo Antiguo Archivo Central del Cauca, del Centro de Investigaciones Históricas José María Arboleda Llorente, Popayán, Colombia.",
        source: `${WORDING} ("digitalizados en alianza con Neogranadina en"); the rest from ${TEMPLATE}:46`,
      },
      hero: {
        path: `${IMG}/ACC_front.jpg`,
        templatePath: "/img/ACC_front.jpg",
        ext: "jpg",
        size: 271863,
        sha256: "deae8f18083f3d1fbf25462ac20c20d273ff6489665dac12443bd73beba7d97e",
        source: `${TEMPLATE}:47`,
      },
      otherNames: {
        value: ["Archivo Central del Cauca"],
        source: `${ACC_PAGE} ("también conocido por su antiguo nombre, Archivo Central del Cauca")`,
      },
      address: { value: "Calle 3 No 5 \u2013 38", source: `${UNICAUCA_AH} ("Calle 3 No 5 \u2013 38")` },
      email: { value: "archivoh@unicauca.edu.co", source: UNICAUCA_AH },
      website: { value: UNICAUCA_AH, source: UNICAUCA_AH },
      rightsText: {
        value:
          "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al Centro de Investigaciones Históricas José María Arboleda Llorente, Universidad del Cauca.",
        replaces:
          "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. Para obtener derechos de reproducción para publicaciones, por favor diríjase al CIHJML, Universidad del Cauca.",
        source: `${WORDING} (the Centro named in full); the rest as D1 repositories.rights_text holds it`,
      },
      accessConditionsEs: {
        value: "Previo diligenciamiento del formato de inscripción y aceptación del reglamento interno.",
        source: `${UNICAUCA_AH}servicios/ (quoted up to "reglamento interno"; the source sentence continues into a list)`,
      },
    },
    "co-ahjci": {
      creditStatementEs: {
        value:
          "Digitalizado en el proyecto EAP1477 del Endangered Archives Programme de la British Library, con el apoyo de la University of Michigan. Neogranadina participó como socia archivística.",
        source: CREDIT,
      },
      creditStatementEn: {
        value:
          "Digitized in project EAP1477 of the British Library's Endangered Archives Programme, with support from the University of Michigan. Neogranadina took part as archival partner.",
        source: CREDIT,
      },
      homeOrder: { value: 2, source: HOME },
      subtitleEn: {
        value: "Materials digitized at the Archivo Histórico del Juzgado del Circuito de Istmina, Chocó, Colombia, in project EAP1477.",
        source: ENGLISH,
      },
      reproductionServicesEn: {
        value: "For reproduction rights for publications, please contact the Archivo Histórico del Juzgado del Circuito de Istmina.",
        source: ENGLISH,
      },
      displayTitle: { value: "Archivo Histórico del Juzgado del Circuito de Istmina", source: `${TEMPLATE}:50` },
      subtitle: {
        value:
          "Materiales digitalizados en el Archivo Histórico del Juzgado del Circuito de Istmina, Chocó, Colombia, en el proyecto EAP1477.",
        source: `${TEMPLATE}:51`,
      },
      region: { value: "Chocó", source: `${TEMPLATE}:51 ("… de Istmina, Chocó, Colombia, …")` },
      hero: {
        path: `${IMG}/istmina.jpg`,
        templatePath: "/img/istmina.jpg",
        ext: "jpg",
        size: 137133,
        sha256: "dbba418cd1a0843887c61c8e655b01d06fff83722c1694a91965b2204b37d5e9",
        source: `${TEMPLATE}:52`,
      },
      historyEs: {
        value: "El Juzgado del Circuito de Istmina produjo los expedientes de este archivo y todavía los custodia. En la segunda mitad del siglo XIX se llamaba Juzgado del Distrito de San Juan y tenía su sede en Nóvita; en la primera década del siglo XX se trasladó a Istmina con parte de su archivo y tomó su nombre actual. Hoy varios juzgados del palacio de justicia de Istmina comparten la responsabilidad del archivo.\n\nLos expedientes estuvieron amontonados en sacos, sin clasificar, hasta que entre 2021 y 2023 Daniel Varela y Angélica Agualimpia los organizaron en dos series, que hoy ocupan 37 cajas. En 2023 se digitalizaron con el proyecto piloto EAP1477 del Endangered Archives Programme de la British Library. Lo dirigió Ann Farnsworth-Alvear, de la Universidad de Pensilvania, en alianza con la Universidad de Michigan, la Fundación Muntú Bantú y la Fundación Histórica Neogranadina como socia archivística.",
        replaces: AHJCI_PREVIOUS_HISTORY_ES,
        source: `https://eap.bl.uk/collection/EAP1477-1; https://eap.bl.uk/project/EAP1477; ${APPROVED}`,
      },
      historyEn: {
        value: "The Circuit Court of Istmina produced the files in this archive and still holds them. In the second half of the nineteenth century it was the San Juan District Court (Juzgado del Distrito de San Juan), seated in Nóvita; in the first decade of the twentieth century it moved to Istmina with part of its archive and took its present name. Today several courts in the Istmina courthouse share responsibility for the archive.\n\nThe files lay in sacks, unsorted, until 2021–2023, when Daniel Varela and Angélica Agualimpia arranged them in two series, now in 37 boxes. In 2023 they were digitized in the pilot project EAP1477 of the British Library's Endangered Archives Programme, led by Ann Farnsworth-Alvear of the University of Pennsylvania in partnership with the University of Michigan, Fundación Muntú Bantú and Fundación Histórica Neogranadina as archival partner.",
        replaces: AHJCI_PREVIOUS_HISTORY_EN,
        source: `https://eap.bl.uk/collection/EAP1477-1; https://eap.bl.uk/project/EAP1477; ${APPROVED}`,
      },
      otherNames: {
        value: ["Istmina Circuit Court Archive", "Juzgado del Distrito de San Juan"],
        source:
          `${EAP_COLLECTION} ("Variant titles: Istmina Circuit Court Archive"; custodial history: ` +
          `"esta corte regional se conoció como Juzgado del Distrito de San Juan con sede en Nóvita"); ${RULING}`,
      },
      funders: [
        {
          kind: "web",
          name: "British Library",
          programme: "Endangered Archives Programme",
          projectId: "EAP1477",
          url: "https://doi.org/10.15130/EAP1477",
          sourceUrl: EAP_PROJECT,
          quote: "Award: £15,000",
          ruling: RULING,
        },
        {
          kind: "web",
          name: "University of Michigan",
          programme: null,
          projectId: null,
          url: null,
          sourceUrl: EAP_PROJECT,
          quote: "In partnership with the University of Michigan, which provided initial funds for the rescue and organisation of the archive",
          ruling: RULING,
        },
      ],
    },
  },
  reproductionServices: {
    column: "rights_text",
    prefix: "Imágenes digitales disponibles en Zasqua mediante IIIF. CC BY-NC 4.0. ",
    sentenceStart: "Para obtener derechos de reproducción",
    source: "D1 repositories.rights_text, the sentence after the licence, verbatim",
  },
  federationNotes: [
    {
      setting: "footer_copyright",
      value: "© {year} Fundación Histórica Neogranadina",
      source: `${HUGO}:80`,
      column: null,
      note: "No column holds a footer line; the name in it is federations.publisher_name.",
    },
    {
      setting: "mets_creator_name",
      value: "Fundación Histórica Neogranadina (NIT 900.861.407), Bogotá, Colombia",
      source: `${HUGO}:97`,
      column: "publisher_name, publisher_tax_id, publisher_location",
      note: "Composed from the three 0118 columns as the publish writes the METS creator.",
    },
    {
      setting: "mets_creator_url",
      value: "https://neogranadina.org",
      source: `${HUGO}:98`,
      column: "publisher_url",
      note: "",
    },
    {
      setting: "mets_default_rights",
      value: "Los catálogos y descripciones de Zasqua son de libre acceso.",
      source: `${HUGO}:101`,
      column: null,
      note: "Prose, not a licence URI: it fills no licence column.",
    },
    {
      setting: "eac_agency_name",
      value: "Fundación Histórica Neogranadina",
      source: `${HUGO}:106`,
      column: "publisher_name",
      note: "",
    },
  ],
};

export const INSTITUTION_SOURCES: Record<string, InstitutionSource> = {
  neogranadina: NEOGRANADINA,
};

// @version v0.9.0
