/**
 * Tests — global search
 *
 * Covers `app/lib/global-search.server.ts`, the workspace-wide search
 * that answers one query from all three full-text indexes at once.
 * What is pinned here is everything the surface cannot check for
 * itself: that the widened record index really does find text nobody
 * could search before, that every category's boundary holds, that the
 * numbers on the tabs and the number driving pagination mean different
 * things and each is honest about which, and that a query with stray
 * punctuation degrades instead of exploding.
 *
 * The refine grammar rides the same fixtures: terms match WHOLE WORDS
 * unless a trailing star asks otherwise, exclusions subtract a known
 * row from rows and counts alike (whichever `q` value carries them), a
 * field-scoped refinement narrows to the record index and blanks the
 * authority categories the way a capability gate does, and quoted
 * compilation makes FTS5 keywords and hyphenated terms ordinary
 * searchable text instead of syntax errors.
 *
 * The second half of the file is about the reads that never touch an
 * index: BROWSE mode, where facet selections and exclusions alone
 * produce rows, and where the numbers, the ordering, and above all the
 * scope predicate have to hold without a MATCH clause to hide behind.
 * Sidebar facet counts are pinned here too — including the
 * short-circuit that keeps a group's unchecked values honest while
 * another group narrows.
 *
 * The ADVANCED sections pin the other grammar against the real index,
 * where the shape of a compiled expression stops being a string and
 * starts being a row set: an OR that unions two records neither of
 * which answers both terms, a NOT that subtracts, and the
 * left-associative reading proved by the one record the two readings
 * disagree about. The DATE sections do the same for the overlap
 * predicate, with a record seeded for every way two spans can meet or
 * miss, because a truth table written down is not a truth table run.
 *
 * HEADING MENTIONS are the same index answering a different question —
 * "which records mention THIS heading?", asked by the decisions surface
 * of a proposal. Pinned here: the phrase tier inside the tenant's own
 * records and nobody else's, the related tier firing only when the
 * phrase found nothing and only on tokens long enough to mean
 * something, the count that reports the phrase tier alone, and a
 * heading full of quotes and punctuation reaching FTS5 as text rather
 * than as syntax.
 *
 * FIXTURES. Two federations and three tenants: the request tenant
 * (Neogranadina, in its own federation), a SIBLING tenant inside the
 * same federation — the one that owns authority records the request
 * tenant must not see — and a second tenant in a second federation,
 * which holds both records and an authority that must stay invisible
 * from the other side. Every search term is unique to the group of
 * fixtures it interrogates (`bautismos`, `cofradia`, `chitagoza`,
 * `guasca`, `paginacion`, `casa`, `quiroga`, `ronquillo`), so one
 * test's counts cannot be moved by another's rows. Browse-mode
 * fixtures live in a repository of their own so a facet can isolate
 * them; the counts that cannot be isolated that way are measured
 * against a baseline read in the same test rather than hard-coded.
 * Nothing here writes, so the fixtures are seeded once.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  SECOND_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
} from "../helpers/db";
import {
  NEOGRANADINA_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
} from "../../app/lib/tenant";
import { parseSearch, parseAdvancedRows } from "../../app/lib/search-query";
import type { AdvancedOp, AdvancedRow, SearchField } from "../../app/lib/search-query";
import {
  runGlobalSearch,
  countHeadingMentions,
  selectHeadingMentions,
  FN_FACET_LIMIT,
  HIGHLIGHT_OPEN,
  HIGHLIGHT_CLOSE,
  SEARCH_PAGE_SIZE,
  SEARCH_PREVIEW_LIMIT,
} from "../../app/lib/global-search.server";
import type {
  DescriptionHit,
  EntityHit,
  GlobalSearchScope,
  PlaceHit,
} from "../../app/lib/global-search.server";

const TENANT_A = NEOGRANADINA_TENANT_ID;
const FED_A = NEOGRANADINA_FEDERATION_ID;
const TENANT_B = SECOND_TEST_TENANT_ID;
const FED_B = SECOND_TEST_FEDERATION_ID;

/** A third tenant, inside the request tenant's own federation. */
const SIBLING_TENANT_ID = "9a9a0000-0000-4000-8000-00000000000a";

const REPO_ONE = "9b000000-0000-4000-8000-000000000001";
const REPO_TWO = "9b000000-0000-4000-8000-000000000002";
const REPO_OTHER = "9b000000-0000-4000-8000-000000000003";
/** The browse playground: a facet on it isolates its three records. */
const REPO_THREE = "9b000000-0000-4000-8000-000000000004";
/** The date playground: every way two spans can meet, and miss. */
const REPO_FOUR = "9b000000-0000-4000-8000-000000000005";
/**
 * The sibling tenant's own repository. It exists so the sibling can
 * hold a RECORD, not just an authority — the heading-mention tier is
 * tenant-scoped, and a neighbour inside the same federation is the
 * sharpest place to prove it.
 */
const REPO_SIBLING = "9b000000-0000-4000-8000-000000000006";

const D_SCOPE = "9c000000-0000-4000-8000-000000000001";
const D_PADRON = "9c000000-0000-4000-8000-000000000002";
const D_COFRADIA_FILE = "9c000000-0000-4000-8000-000000000003";
const D_COFRADIA_ITEM = "9c000000-0000-4000-8000-000000000004";
const D_COFRADIA_REPO_TWO = "9c000000-0000-4000-8000-000000000005";
const D_OTHER_TENANT = "9c000000-0000-4000-8000-000000000006";
const D_CASA = "9c000000-0000-4000-8000-000000000007";
const D_CASARIN = "9c000000-0000-4000-8000-000000000008";
const D_SERIE_Q = "9c000000-0000-4000-8000-000000000009";
/** The three browse records, deliberately out of order on every key. */
const D_BROWSE_ALPHA = "9c000000-0000-4000-8000-00000000000a";
const D_BROWSE_BRAVO = "9c000000-0000-4000-8000-00000000000b";
const D_BROWSE_CHARLIE = "9c000000-0000-4000-8000-00000000000c";
const D_OTHER_BROWSE = "9c000000-0000-4000-8000-00000000000d";
/**
 * The advanced-grammar quartet. All four carry the marker word
 * `sutatausa`, so a query can bound its universe to them; then one
 * holds `tequendama`, one `sogamoso`, one `guatavita`, and the fourth
 * holds `tequendama` AND `guatavita` — which is the record the
 * left- and right-associative readings of `a OR b NOT c` disagree
 * about, and therefore the whole point of it.
 */
const D_ADV_TEQ = "9c000000-0000-4000-8000-00000000001a";
const D_ADV_SOG = "9c000000-0000-4000-8000-00000000001b";
const D_ADV_GUA = "9c000000-0000-4000-8000-00000000001c";
const D_ADV_TEQ_GUA = "9c000000-0000-4000-8000-00000000001d";
/** The field-scope pair: one holds `chiscas` in its title, one in scope. */
const D_ADV_TITLE = "9c000000-0000-4000-8000-00000000001e";
const D_ADV_SCOPE = "9c000000-0000-4000-8000-00000000001f";

/**
 * The date playground, one record per row of the overlap truth table,
 * measured against the range 1650–1700. Levels are mixed so a date
 * bound is visibly narrowing the sidebar as well as the rows.
 */
const D_DATE_INSIDE = "9c000000-0000-4000-8000-00000000002a";
const D_DATE_STRADDLE_START = "9c000000-0000-4000-8000-00000000002b";
const D_DATE_STRADDLE_END = "9c000000-0000-4000-8000-00000000002c";
const D_DATE_CONTAINING = "9c000000-0000-4000-8000-00000000002d";
const D_DATE_BEFORE = "9c000000-0000-4000-8000-00000000002e";
const D_DATE_AFTER = "9c000000-0000-4000-8000-00000000002f";
const D_DATE_NONE = "9c000000-0000-4000-8000-000000000030";
/** Start date only, its end stored as the empty string a cleared field leaves. */
const D_DATE_EMPTY_END = "9c000000-0000-4000-8000-000000000031";
/** A year-only start date, the shape 429 live records carry. */
const D_DATE_YEAR_ONLY = "9c000000-0000-4000-8000-000000000032";
/** An empty-string start date: unplaceable, out of every bounded range. */
const D_DATE_EMPTY_START = "9c000000-0000-4000-8000-000000000033";
/** Everything seeded into the date playground. */
const DATE_FIXTURE_COUNT = 10;

/**
 * The heading-mention fixtures. `ubaque` marks the phrase group: the
 * heading in a title, the same heading in another record's scope and
 * content, and a third copy owned by the sibling tenant. `mojones`
 * marks the related group, paired with a record whose only overlap
 * with that heading is a three-letter word — the token the tier is
 * built to drop.
 */
const D_HEAD_TITLE = "9c000000-0000-4000-8000-00000000003a";
const D_HEAD_SCOPE = "9c000000-0000-4000-8000-00000000003b";
const D_HEAD_SIBLING = "9c000000-0000-4000-8000-00000000003c";
const D_HEAD_RELATED = "9c000000-0000-4000-8000-00000000003d";
const D_HEAD_SHORT_ONLY = "9c000000-0000-4000-8000-00000000003e";

const E_SHARED = "9d000000-0000-4000-8000-000000000001";
const E_OWN = "9d000000-0000-4000-8000-000000000002";
const E_SIBLING = "9d000000-0000-4000-8000-000000000003";
const E_OTHER_FED = "9d000000-0000-4000-8000-000000000004";
const E_MERGED = "9d000000-0000-4000-8000-000000000005";
const E_SORT_ANA = "9d000000-0000-4000-8000-000000000006";
const E_SORT_BRUNA = "9d000000-0000-4000-8000-000000000007";
const E_SORT_CARLOS = "9d000000-0000-4000-8000-000000000008";

const P_SHARED = "9e000000-0000-4000-8000-000000000001";
const P_OWN = "9e000000-0000-4000-8000-000000000002";
const P_SIBLING = "9e000000-0000-4000-8000-000000000003";
const P_OTHER_FED = "9e000000-0000-4000-8000-000000000004";
const P_MERGED = "9e000000-0000-4000-8000-000000000005";

/** How many paginated records the boundary test seeds. */
const PAGINATION_ROWS = SEARCH_PAGE_SIZE + 2;
/** One more distinct function value than the facet group offers. */
const FN_FIXTURE_COUNT = FN_FACET_LIMIT + 1;

function db() {
  return drizzle(env.DB, { schema });
}

function scope(overrides: Partial<GlobalSearchScope> = {}): GlobalSearchScope {
  return {
    tenantId: TENANT_A,
    federationId: FED_A,
    includeAuthorities: true,
    ...overrides,
  };
}

async function seedSiblingTenant(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, federation_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      SIBLING_TENANT_ID, "gs-sibling", "Sibling Tenant", "tenant", "isadg", "active",
      0, 1, 0, 0, null, FED_A, now, now,
    )
    .run();
}

async function seedRepository(id: string, tenantId: string, code: string): Promise<void> {
  const now = Date.now();
  await db().insert(schema.repositories).values({
    id,
    tenantId,
    code,
    name: `Repository ${code}`,
    countryCode: "COL",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedDescription(values: {
  id: string;
  tenantId: string;
  repositoryId: string;
  referenceCode: string;
  title: string;
  level?: (typeof schema.descriptions.$inferInsert)["descriptionLevel"];
  scopeContent?: string | null;
  notes?: string | null;
  legacyIds?: string;
  dateExpression?: string | null;
  dateStart?: string | null;
  dateEnd?: string | null;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.descriptions).values({
    id: values.id,
    tenantId: values.tenantId,
    repositoryId: values.repositoryId,
    descriptionLevel: values.level ?? "item",
    referenceCode: values.referenceCode,
    title: values.title,
    scopeContent: values.scopeContent ?? null,
    notes: values.notes ?? null,
    legacyIds: values.legacyIds ?? "[]",
    dateExpression: values.dateExpression ?? null,
    dateStart: values.dateStart ?? null,
    dateEnd: values.dateEnd ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

/** One advanced row, spelled out so a test reads as the form reads. */
function row(op: AdvancedOp, field: SearchField | null, term: string): AdvancedRow {
  return { op, field, term };
}

async function seedEntity(values: {
  id: string;
  federationId: string;
  tenantId: string | null;
  displayName: string;
  entityCode?: string | null;
  entityType?: (typeof schema.entities.$inferInsert)["entityType"];
  primaryFunction?: string | null;
  mergedInto?: string | null;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.entities).values({
    id: values.id,
    federationId: values.federationId,
    tenantId: values.tenantId,
    entityCode:
      values.entityCode === undefined ? `ne-${values.id.slice(-6)}` : values.entityCode,
    displayName: values.displayName,
    sortName: values.displayName.toLowerCase(),
    entityType: values.entityType ?? "person",
    primaryFunction: values.primaryFunction ?? null,
    mergedInto: values.mergedInto ?? null,
    nameVariants: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPlace(values: {
  id: string;
  federationId: string;
  tenantId: string | null;
  displayName: string;
  placeType?: (typeof schema.places.$inferInsert)["placeType"];
  mergedInto?: string | null;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.places).values({
    id: values.id,
    federationId: values.federationId,
    tenantId: values.tenantId,
    placeCode: `nl-${values.id.slice(-6)}`,
    label: values.displayName,
    displayName: values.displayName,
    placeType: values.placeType ?? null,
    mergedInto: values.mergedInto ?? null,
    nameVariants: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedFixtures(): Promise<void> {
  await seedSiblingTenant();

  await seedRepository(REPO_ONE, TENANT_A, "GS-ONE");
  await seedRepository(REPO_TWO, TENANT_A, "GS-TWO");
  await seedRepository(REPO_OTHER, TENANT_B, "GS-OTR");
  await seedRepository(REPO_THREE, TENANT_A, "GS-THR");
  await seedRepository(REPO_FOUR, TENANT_A, "GS-FOU");
  await seedRepository(REPO_SIBLING, SIBLING_TENANT_ID, "GS-SIB");

  // The widened index's whole point: text that lives in scope and
  // content and in the legacy identifiers, not in the title.
  await seedDescription({
    id: D_SCOPE,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-001",
    title: "Libro de bautismos",
    level: "file",
    scopeContent: "Registro de la misión de Chita y sus visitas pastorales",
    legacyIds: '["former-reference-geiger-155"]',
    dateExpression: "1750-1780",
  });
  // A record whose scope is empty, so the snippet has nothing to say.
  await seedDescription({
    id: D_PADRON,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-002",
    title: "Padrón de la misión",
    level: "item",
    scopeContent: null,
  });
  // The facet trio: three records on one term, two levels, two
  // repositories.
  await seedDescription({
    id: D_COFRADIA_FILE,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-010",
    title: "Cofradía del Rosario",
    level: "file",
  });
  await seedDescription({
    id: D_COFRADIA_ITEM,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-011",
    title: "Cofradía de ánimas",
    level: "item",
  });
  await seedDescription({
    id: D_COFRADIA_REPO_TWO,
    tenantId: TENANT_A,
    repositoryId: REPO_TWO,
    referenceCode: "SBM-012",
    title: "Cofradía de San José",
    level: "item",
  });
  // The whole-word pair: one record holding the WORD casa, one holding
  // a longer word that merely starts with it.
  await seedDescription({
    id: D_CASA,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-020",
    title: "Casa de moneda",
    level: "item",
  });
  await seedDescription({
    id: D_CASARIN,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-021",
    title: "Colección Casarín",
    level: "item",
  });
  // A one-letter word, searchable now that no length rule exists.
  await seedDescription({
    id: D_SERIE_Q,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-022",
    title: "Serie Q",
    level: "series",
  });
  // Another tenant's record, on a term the request tenant also matches.
  await seedDescription({
    id: D_OTHER_TENANT,
    tenantId: TENANT_B,
    repositoryId: REPO_OTHER,
    referenceCode: "OTR-001",
    title: "Libro de bautismos ajeno",
    level: "file",
  });
  // The browse playground. Titles, codes and dates each order the
  // three differently, and one date is missing so NULL placement is
  // observable in both directions.
  await seedDescription({
    id: D_BROWSE_ALPHA,
    tenantId: TENANT_A,
    repositoryId: REPO_THREE,
    referenceCode: "SBM-S03",
    title: "alpha expediente",
    level: "file",
    dateStart: "1750-06-01",
  });
  await seedDescription({
    id: D_BROWSE_BRAVO,
    tenantId: TENANT_A,
    repositoryId: REPO_THREE,
    referenceCode: "SBM-S01",
    title: "Bravo expediente",
    level: "item",
    dateStart: "1600-02-01",
  });
  await seedDescription({
    id: D_BROWSE_CHARLIE,
    tenantId: TENANT_A,
    repositoryId: REPO_THREE,
    referenceCode: "SBM-S02",
    title: "charlie expediente",
    level: "item",
    dateStart: null,
  });
  // The other tenant's look-alike, for the browse isolation pin.
  await seedDescription({
    id: D_OTHER_BROWSE,
    tenantId: TENANT_B,
    repositoryId: REPO_OTHER,
    referenceCode: "OTR-S01",
    title: "Bravo expediente ajeno",
    level: "item",
    dateStart: "1600-02-01",
  });
  // The advanced quartet, all four on the marker word.
  await seedDescription({
    id: D_ADV_TEQ,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-A01",
    // `zipacon` is this record's alone, so an OR against `sogamoso`
    // unions exactly two records and neither answers both terms.
    title: "Sutatausa tequendama zipacon",
    level: "item",
  });
  await seedDescription({
    id: D_ADV_SOG,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-A02",
    title: "Sutatausa sogamoso",
    level: "item",
  });
  await seedDescription({
    id: D_ADV_GUA,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-A03",
    title: "Sutatausa guatavita",
    level: "item",
  });
  await seedDescription({
    id: D_ADV_TEQ_GUA,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-A04",
    title: "Sutatausa tequendama guatavita",
    level: "item",
  });
  // The field-scope pair: the same word, once in a title and once in
  // the scope and content of a record whose title never says it.
  await seedDescription({
    id: D_ADV_TITLE,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-A05",
    title: "Chiscas legajo",
    level: "item",
  });
  await seedDescription({
    id: D_ADV_SCOPE,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-A06",
    title: "Legajo mudo",
    level: "item",
    scopeContent: "Traslado de una escritura de chiscas",
  });

  // The date playground. One record per row of the overlap truth
  // table, measured against 1650-1700; the marker word is `tibasosa`.
  await seedDescription({
    id: D_DATE_INSIDE,
    tenantId: TENANT_A,
    repositoryId: REPO_FOUR,
    referenceCode: "SBM-D01",
    title: "Tibasosa dentro",
    level: "file",
    dateStart: "1660-01-01",
    dateEnd: "1670-12-31",
  });
  await seedDescription({
    id: D_DATE_STRADDLE_START,
    tenantId: TENANT_A,
    repositoryId: REPO_FOUR,
    referenceCode: "SBM-D02",
    title: "Tibasosa cruza el inicio",
    level: "item",
    dateStart: "1600-01-01",
    dateEnd: "1660-01-01",
  });
  await seedDescription({
    id: D_DATE_STRADDLE_END,
    tenantId: TENANT_A,
    repositoryId: REPO_FOUR,
    referenceCode: "SBM-D03",
    title: "Tibasosa cruza el final",
    level: "item",
    dateStart: "1690-01-01",
    dateEnd: "1750-01-01",
  });
  await seedDescription({
    id: D_DATE_CONTAINING,
    tenantId: TENANT_A,
    repositoryId: REPO_FOUR,
    referenceCode: "SBM-D04",
    title: "Tibasosa lo contiene",
    level: "series",
    dateStart: "1500-01-01",
    dateEnd: "1900-01-01",
  });
  await seedDescription({
    id: D_DATE_BEFORE,
    tenantId: TENANT_A,
    repositoryId: REPO_FOUR,
    referenceCode: "SBM-D05",
    title: "Tibasosa anterior",
    level: "item",
    dateStart: "1500-01-01",
    dateEnd: "1600-01-01",
  });
  await seedDescription({
    id: D_DATE_AFTER,
    tenantId: TENANT_A,
    repositoryId: REPO_FOUR,
    referenceCode: "SBM-D06",
    title: "Tibasosa posterior",
    level: "item",
    dateStart: "1800-01-01",
    dateEnd: "1900-01-01",
  });
  await seedDescription({
    id: D_DATE_NONE,
    tenantId: TENANT_A,
    repositoryId: REPO_FOUR,
    referenceCode: "SBM-D07",
    title: "Tibasosa sin fecha",
    level: "item",
    dateStart: null,
    dateEnd: null,
  });
  await seedDescription({
    id: D_DATE_EMPTY_END,
    tenantId: TENANT_A,
    repositoryId: REPO_FOUR,
    referenceCode: "SBM-D08",
    title: "Tibasosa con fin vacio",
    level: "file",
    dateStart: "1660-01-01",
    dateEnd: "",
  });
  // A year-only start, as 429 live records carry: it must be inside a
  // range that begins in its own year, which a lexicographic compare
  // against a full ISO bound would deny ('1580' < '1580-01-01').
  await seedDescription({
    id: D_DATE_YEAR_ONLY,
    tenantId: TENANT_A,
    repositoryId: REPO_FOUR,
    referenceCode: "SBM-D09",
    title: "Tibasosa con solo el anno",
    level: "file",
    dateStart: "1580",
    dateEnd: null,
  });
  // An empty-string start: unplaceable on the timeline, so it must
  // stay out of every bounded range instead of comparing before all
  // of them.
  await seedDescription({
    id: D_DATE_EMPTY_START,
    tenantId: TENANT_A,
    repositoryId: REPO_FOUR,
    referenceCode: "SBM-D10",
    title: "Tibasosa con inicio vacio",
    level: "file",
    dateStart: "",
    dateEnd: "1660-01-01",
  });

  // The heading-mention fixtures. The phrase "Cacicazgo de Ubaque"
  // lands once in a title and once in a scope note, so the count has
  // two to find; the sibling tenant holds a third copy that must never
  // reach the request tenant's evidence list.
  await seedDescription({
    id: D_HEAD_TITLE,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-H01",
    title: "Cacicazgo de Ubaque y su encomienda",
    level: "file",
  });
  await seedDescription({
    id: D_HEAD_SCOPE,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-H02",
    title: "Cuaderno segundo",
    level: "item",
    scopeContent: "Traslado del cacicazgo de Ubaque, en dos fojas",
  });
  await seedDescription({
    id: D_HEAD_SIBLING,
    tenantId: SIBLING_TENANT_ID,
    repositoryId: REPO_SIBLING,
    referenceCode: "SIB-H01",
    title: "Cacicazgo de Ubaque, traslado ajeno",
    level: "item",
  });
  // The related pair, measured against the heading "Los mojones de
  // Suba": one record answers its long token, the other holds only the
  // three-letter one the tier drops.
  await seedDescription({
    id: D_HEAD_RELATED,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-H03",
    title: "Mojones y linderos antiguos",
    level: "item",
  });
  await seedDescription({
    id: D_HEAD_SHORT_ONLY,
    tenantId: TENANT_A,
    repositoryId: REPO_ONE,
    referenceCode: "SBM-H04",
    title: "Los cuadernillos rotos",
    level: "item",
  });

  // Enough records on one term to need a second page.
  for (let i = 0; i < PAGINATION_ROWS; i++) {
    await seedDescription({
      id: `9f000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      tenantId: TENANT_A,
      repositoryId: REPO_ONE,
      referenceCode: `SBM-PAG-${String(i).padStart(3, "0")}`,
      title: `Expediente de paginacion ${i}`,
      level: "item",
    });
  }

  await seedEntity({
    id: E_SHARED,
    federationId: FED_A,
    tenantId: null,
    displayName: "Ana Chitagoza",
    entityType: "person",
    primaryFunction: "escribano",
  });
  await seedEntity({
    id: E_OWN,
    federationId: FED_A,
    tenantId: TENANT_A,
    displayName: "Beatriz Chitagoza",
    entityType: "person",
    primaryFunction: "cacique",
  });
  await seedEntity({
    id: E_SIBLING,
    federationId: FED_A,
    tenantId: SIBLING_TENANT_ID,
    displayName: "Carlos Chitagoza",
  });
  await seedEntity({
    id: E_OTHER_FED,
    federationId: FED_B,
    tenantId: null,
    displayName: "Diana Chitagoza",
  });
  await seedEntity({
    id: E_MERGED,
    federationId: FED_A,
    tenantId: null,
    displayName: "Elena Chitagoza",
    mergedInto: E_SHARED,
  });
  // The name-sort trio: three types, mixed capitals, one without a code.
  await seedEntity({
    id: E_SORT_ANA,
    federationId: FED_A,
    tenantId: null,
    displayName: "Ana Quiroga",
    entityCode: "ne-quiroga-01",
    entityType: "person",
  });
  await seedEntity({
    id: E_SORT_BRUNA,
    federationId: FED_A,
    tenantId: null,
    displayName: "bruna Quiroga",
    entityCode: "ne-quiroga-02",
    entityType: "corporate",
  });
  await seedEntity({
    id: E_SORT_CARLOS,
    federationId: FED_A,
    tenantId: null,
    displayName: "Carlos Quiroga",
    entityCode: null,
    entityType: "family",
  });
  // One more distinct function than the facet group shows, each on one
  // record, so the cut falls on the alphabetical tiebreaker.
  for (let i = 1; i <= FN_FIXTURE_COUNT; i++) {
    await seedEntity({
      id: `9d000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
      federationId: FED_A,
      tenantId: null,
      displayName: `Persona Ronquillo ${i}`,
      entityCode: `ne-ronquillo-${String(i).padStart(2, "0")}`,
      entityType: "person",
      primaryFunction: `fn-${String(i).padStart(2, "0")}`,
    });
  }

  await seedPlace({
    id: P_SHARED,
    federationId: FED_A,
    tenantId: null,
    displayName: "Guasca",
    placeType: "town",
  });
  await seedPlace({
    id: P_OWN,
    federationId: FED_A,
    tenantId: TENANT_A,
    displayName: "Guasca la Vieja",
    placeType: "parish",
  });
  await seedPlace({
    id: P_SIBLING,
    federationId: FED_A,
    tenantId: SIBLING_TENANT_ID,
    displayName: "Guasca Ajena",
  });
  await seedPlace({
    id: P_OTHER_FED,
    federationId: FED_B,
    tenantId: null,
    displayName: "Guasca Lejana",
  });
  await seedPlace({
    id: P_MERGED,
    federationId: FED_A,
    tenantId: null,
    displayName: "Guasca Duplicada",
    mergedInto: P_SHARED,
  });
}

/** Marked text as the reader sees it, with the markers taken out. */
function unmark(value: string | null): string {
  if (value === null) return "";
  return value.split(HIGHLIGHT_OPEN).join("").split(HIGHLIGHT_CLOSE).join("");
}

/** Every term the markers wrap, in order. */
function markedTerms(value: string | null): string[] {
  if (value === null) return [];
  const terms: string[] = [];
  const parts = value.split(HIGHLIGHT_OPEN);
  for (const part of parts.slice(1)) {
    const [term] = part.split(HIGHLIGHT_CLOSE);
    if (term !== undefined) terms.push(term);
  }
  return terms;
}

/** The ids of a category page, in the order the read returned them. */
function pageIds(rows: unknown): string[] {
  return (rows as { id: string }[]).map((row) => row.id);
}

describe("global search", () => {
  beforeAll(async () => {
    await applyMigrations();
    await cleanDatabase();
    await seedFixtures();
  });

  describe("what the widened record index can now find", () => {
    it("finds a record by text that lives only in scope and content", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["pastorales"]), {
        category: "all",
      });
      expect(result.counts.descriptions).toBe(1);
      expect(result.mode).toBe("match");
      const rows = result.preview?.descriptions ?? [];
      expect(rows.map((r) => r.id)).toEqual([D_SCOPE]);
      // The snippet is present and marks the matched term.
      expect(rows[0].scopeSnippet).not.toBeNull();
      expect(markedTerms(rows[0].scopeSnippet)).toContain("pastorales");
      expect(unmark(rows[0].scopeSnippet)).toContain("visitas pastorales");
    });

    it("finds a record by text that lives only in its notes", async () => {
      // The third column 0075 added; without this pin, a trigger edit
      // could silently un-index it and the suite would stay green.
      await seedDescription({
        id: "9c000000-0000-4000-8000-00000000n0te",
        tenantId: TENANT_A,
        repositoryId: REPO_ONE,
        referenceCode: "SBM-090",
        title: "Expediente sin señas",
        notes: "Encuadernación restaurada por Zalamea en 1998",
      });
      const result = await runGlobalSearch(db(), scope(), parseSearch(["zalamea"]), {
        category: "all",
      });
      expect(result.counts.descriptions).toBe(1);
      expect(result.preview?.descriptions.map((r) => r.referenceCode)).toEqual(
        ["SBM-090"],
      );
    });

    it("finds a record by a legacy identifier", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["geiger"]), {
        category: "all",
      });
      expect(result.counts.descriptions).toBe(1);
      expect(result.preview?.descriptions.map((r) => r.id)).toEqual([D_SCOPE]);
    });

    it("marks the matched token inside the title and carries the record's meta", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["bautismos"]), {
        category: "all",
      });
      const hit = (result.preview?.descriptions ?? [])[0];
      expect(hit.id).toBe(D_SCOPE);
      expect(hit.titleMarked).toBe(
        `Libro de ${HIGHLIGHT_OPEN}bautismos${HIGHLIGHT_CLOSE}`,
      );
      expect(unmark(hit.titleMarked)).toBe("Libro de bautismos");
      expect(hit.referenceCode).toBe("SBM-001");
      expect(hit.level).toBe("file");
      expect(hit.dateExpression).toBe("1750-1780");
    });

    it("reports no snippet at all when the record's scope is empty", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["padron"]), {
        category: "all",
      });
      const rows = result.preview?.descriptions ?? [];
      expect(rows.map((r) => r.id)).toEqual([D_PADRON]);
      expect(rows[0].scopeSnippet).toBeNull();
    });

    it("folds accents, so an unaccented query finds the accented text", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["mision"]), {
        category: "all",
      });
      expect(result.counts.descriptions).toBe(2);
      const ids = (result.preview?.descriptions ?? []).map((r) => r.id).sort();
      expect(ids).toEqual([D_SCOPE, D_PADRON].sort());
    });
  });

  describe("whole words, and the star that opts out", () => {
    it("matches the word, not every word that starts with it", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["casa"]), {
        category: "all",
      });
      expect(result.counts.descriptions).toBe(1);
      const ids = (result.preview?.descriptions ?? []).map((r) => r.id);
      expect(ids).toEqual([D_CASA]);
      expect(ids).not.toContain(D_CASARIN);
    });

    it("expands to the longer words when the term ends in a star", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["casa*"]), {
        category: "all",
      });
      expect(result.counts.descriptions).toBe(2);
      expect((result.preview?.descriptions ?? []).map((r) => r.id).sort()).toEqual(
        [D_CASA, D_CASARIN].sort(),
      );
    });

    it("honours the star on a refinement as well as the box", async () => {
      const result = await runGlobalSearch(
        db(),
        scope(),
        parseSearch(["", "title:casa*"]),
        { category: "descriptions", page: 1, facets: {}, sort: null },
      );
      expect(result.page?.total).toBe(2);
    });

    it("searches a one-character term end to end", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["q"]), {
        category: "all",
      });
      expect(result.counts.descriptions).toBe(1);
      expect((result.preview?.descriptions ?? []).map((r) => r.id)).toEqual([
        D_SERIE_Q,
      ]);
    });
  });

  describe("boundaries", () => {
    it("never returns another tenant's record", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["bautismos"]), {
        category: "all",
      });
      expect(result.counts.descriptions).toBe(1);
      const ids = (result.preview?.descriptions ?? []).map((r) => r.id);
      expect(ids).toEqual([D_SCOPE]);
      expect(ids).not.toContain(D_OTHER_TENANT);
    });

    it("returns the other tenant's record when that tenant is the one searching", async () => {
      const result = await runGlobalSearch(
        db(),
        scope({ tenantId: TENANT_B, federationId: FED_B }),
        parseSearch(["bautismos"]),
        { category: "all" },
      );
      expect(result.counts.descriptions).toBe(1);
      expect(result.preview?.descriptions.map((r) => r.id)).toEqual([
        D_OTHER_TENANT,
      ]);
    });

    it("shows shared and own authority records, and nobody else's", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["chitagoza"]), {
        category: "all",
      });
      expect(result.counts.entities).toBe(2);
      const ids = (result.preview?.entities ?? []).map((r) => r.id).sort();
      expect(ids).toEqual([E_SHARED, E_OWN].sort());
      // A sibling tenant's own record, another federation's record, and
      // a record merged away are all absent.
      expect(ids).not.toContain(E_SIBLING);
      expect(ids).not.toContain(E_OTHER_FED);
      expect(ids).not.toContain(E_MERGED);
    });

    it("applies the same authority rule to places", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["guasca"]), {
        category: "all",
      });
      expect(result.counts.places).toBe(2);
      const rows = result.preview?.places ?? [];
      expect(rows.map((r) => r.id).sort()).toEqual([P_SHARED, P_OWN].sort());
      const shared = rows.find((r) => r.id === P_SHARED) as PlaceHit;
      expect(shared.displayName).toBe("Guasca");
      expect(shared.placeType).toBe("town");
      expect(shared.placeCode).toBe(`nl-${P_SHARED.slice(-6)}`);
    });

    it("carries the entity's own fields onto the hit", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["chitagoza"]), {
        category: "all",
      });
      const hit = (result.preview?.entities ?? []).find(
        (r) => r.id === E_SHARED,
      ) as EntityHit;
      expect(hit.displayName).toBe("Ana Chitagoza");
      expect(hit.entityType).toBe("person");
      expect(hit.primaryFunction).toBe("escribano");
      expect(hit.entityCode).toBe(`ne-${E_SHARED.slice(-6)}`);
    });
  });

  describe("authorities out of scope", () => {
    it("omits the authority categories entirely rather than reporting zero", async () => {
      const result = await runGlobalSearch(
        db(),
        scope({ includeAuthorities: false }),
        parseSearch(["chitagoza"]),
        { category: "all" },
      );
      expect(result.counts.descriptions).toBe(0);
      expect(result.counts).not.toHaveProperty("entities");
      expect(result.counts).not.toHaveProperty("places");
      expect(result.counts.entities).toBeUndefined();
      expect(result.counts.places).toBeUndefined();
      expect(result.preview?.entities).toEqual([]);
      expect(result.preview?.places).toEqual([]);
      // The sidebar follows the same rule: no groups for categories
      // the viewer cannot reach.
      expect(result.facetCounts).not.toHaveProperty("entityTypes");
      expect(result.facetCounts).not.toHaveProperty("fns");
      expect(result.facetCounts).not.toHaveProperty("placeTypes");
      expect(result.facetCounts.levels).toBeDefined();
      expect(result.facetCounts.repositories).toBeDefined();
    });

    it("keeps authority counts absent on the single-category path too", async () => {
      // The records tab for an ungated viewer must not carry authority
      // numbers as teasers — the leak decision 3 exists to prevent.
      const result = await runGlobalSearch(
        db(),
        scope({ includeAuthorities: false }),
        parseSearch(["pastorales"]),
        { category: "descriptions", page: 1, facets: {}, sort: null },
      );
      expect(result.counts.descriptions).toBe(1);
      expect(result.counts).not.toHaveProperty("entities");
      expect(result.counts).not.toHaveProperty("places");
      expect(result.page?.total).toBe(1);
    });

    it("refuses an authority category the caller should have coerced away", async () => {
      await expect(
        runGlobalSearch(db(), scope({ includeAuthorities: false }), parseSearch(["chitagoza"]), {
          category: "entities",
          page: 1,
          facets: {},
          sort: null,
        }),
      ).rejects.toThrow(/authorities/i);
    });
  });

  describe("counts and facets", () => {
    it("keeps the tab count facet-free while the total follows the facets", async () => {
      const unfiltered = await runGlobalSearch(db(), scope(), parseSearch(["cofradia"]), {
        category: "descriptions",
        page: 1,
        facets: {},
        sort: null,
      });
      expect(unfiltered.counts.descriptions).toBe(3);
      expect(unfiltered.page?.total).toBe(3);

      const byLevel = await runGlobalSearch(db(), scope(), parseSearch(["cofradia"]), {
        category: "descriptions",
        page: 1,
        facets: { levels: ["item"] },
        sort: null,
      });
      // The tab still counts every match; the total counts the page's own.
      expect(byLevel.counts.descriptions).toBe(3);
      expect(byLevel.page?.total).toBe(2);
      expect(pageIds(byLevel.page?.rows).sort()).toEqual(
        [D_COFRADIA_ITEM, D_COFRADIA_REPO_TWO].sort(),
      );

      const byRepository = await runGlobalSearch(db(), scope(), parseSearch(["cofradia"]), {
        category: "descriptions",
        page: 1,
        facets: { repoIds: [REPO_TWO] },
        sort: null,
      });
      expect(byRepository.counts.descriptions).toBe(3);
      expect(byRepository.page?.total).toBe(1);
      expect(pageIds(byRepository.page?.rows)).toEqual([D_COFRADIA_REPO_TWO]);

      const both = await runGlobalSearch(db(), scope(), parseSearch(["cofradia"]), {
        category: "descriptions",
        page: 1,
        facets: { levels: ["file"], repoIds: [REPO_TWO] },
        sort: null,
      });
      expect(both.page?.total).toBe(0);
      expect(both.page?.rows).toEqual([]);
    });

    it("ORs several values inside one group and ANDs across groups", async () => {
      const orWithin = await runGlobalSearch(db(), scope(), parseSearch(["cofradia"]), {
        category: "descriptions",
        page: 1,
        facets: { levels: ["file", "item"] },
        sort: null,
      });
      expect(orWithin.page?.total).toBe(3);
      expect(pageIds(orWithin.page?.rows).sort()).toEqual(
        [D_COFRADIA_FILE, D_COFRADIA_ITEM, D_COFRADIA_REPO_TWO].sort(),
      );

      const andAcross = await runGlobalSearch(db(), scope(), parseSearch(["cofradia"]), {
        category: "descriptions",
        page: 1,
        facets: { levels: ["file", "item"], repoIds: [REPO_ONE] },
        sort: null,
      });
      expect(andAcross.page?.total).toBe(2);
      expect(pageIds(andAcross.page?.rows).sort()).toEqual(
        [D_COFRADIA_FILE, D_COFRADIA_ITEM].sort(),
      );
    });

    it("ORs several values inside an authority group too", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["quiroga"]), {
        category: "entities",
        page: 1,
        facets: { entityTypes: ["person", "family"] },
        sort: null,
      });
      expect(result.counts.entities).toBe(3);
      expect(result.page?.total).toBe(2);
      expect(pageIds(result.page?.rows).sort()).toEqual(
        [E_SORT_ANA, E_SORT_CARLOS].sort(),
      );
    });

    it("keeps the other categories' tabs live while one category is paged", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["chitagoza"]), {
        category: "entities",
        page: 1,
        facets: { entityTypes: ["person"], fns: ["escribano"] },
        sort: null,
      });
      expect(result.counts.descriptions).toBe(0);
      expect(result.counts.entities).toBe(2);
      expect(result.counts.places).toBe(0);
      expect(result.page?.total).toBe(1);
      expect(pageIds(result.page?.rows)).toEqual([E_SHARED]);
    });

    it("facets places by type without moving the place tab count", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["guasca"]), {
        category: "places",
        page: 1,
        facets: { placeTypes: ["parish"] },
        sort: null,
      });
      expect(result.counts.places).toBe(2);
      expect(result.counts.entities).toBe(0);
      expect(result.page?.total).toBe(1);
      expect(pageIds(result.page?.rows)).toEqual([P_OWN]);
    });

    it("shows at most the preview limit per group in the combined view", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["paginacion"]), {
        category: "all",
      });
      expect(result.counts.descriptions).toBe(PAGINATION_ROWS);
      expect(result.preview?.descriptions).toHaveLength(SEARCH_PREVIEW_LIMIT);
    });
  });

  describe("the sidebar's facet counts", () => {
    it("counts every group under the query on the combined view", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["cofradia"]), {
        category: "all",
      });
      expect(result.facetCounts.levels).toEqual([
        { value: "item", count: 2 },
        { value: "file", count: 1 },
      ]);
      const repositories = result.facetCounts.repositories ?? [];
      expect(repositories).toEqual([
        { id: REPO_ONE, name: "Repository GS-ONE", count: 2 },
        { id: REPO_TWO, name: "Repository GS-TWO", count: 1 },
      ]);
    });

    it("short-circuits a group's own selections so its siblings stay honest", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["cofradia"]), {
        category: "descriptions",
        page: 1,
        facets: { levels: ["item"] },
        sort: null,
      });
      // "file" is unchecked and narrowed away from the rows, but its
      // count still says what checking it would add.
      expect(result.facetCounts.levels).toEqual([
        { value: "item", count: 2 },
        { value: "file", count: 1 },
      ]);
      // The repository group, by contrast, DOES feel the level
      // selection: across groups the narrowing is cumulative.
      expect(result.facetCounts.repositories).toEqual([
        { id: REPO_ONE, name: "Repository GS-ONE", count: 1 },
        { id: REPO_TWO, name: "Repository GS-TWO", count: 1 },
      ]);
    });

    it("never counts another tenant's repository", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["bautismos"]), {
        category: "all",
      });
      const ids = (result.facetCounts.repositories ?? []).map((r) => r.id);
      expect(ids).toEqual([REPO_ONE]);
      expect(ids).not.toContain(REPO_OTHER);
    });

    it("counts the authority groups under the same rules", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["quiroga"]), {
        category: "entities",
        page: 1,
        facets: { entityTypes: ["person"] },
        sort: null,
      });
      // Own group short-circuited: all three types keep their counts.
      expect(result.facetCounts.entityTypes).toEqual([
        { value: "corporate", count: 1 },
        { value: "family", count: 1 },
        { value: "person", count: 1 },
      ]);
      const places = await runGlobalSearch(db(), scope(), parseSearch(["guasca"]), {
        category: "places",
        page: 1,
        facets: {},
        sort: null,
      });
      expect(places.facetCounts.placeTypes).toEqual([
        { value: "parish", count: 1 },
        { value: "town", count: 1 },
      ]);
    });

    it("caps the function group but keeps a selected value below the cut", async () => {
      const unselected = await runGlobalSearch(db(), scope(), parseSearch(["ronquillo"]), {
        category: "entities",
        page: 1,
        facets: {},
        sort: null,
      });
      const shown = unselected.facetCounts.fns ?? [];
      expect(shown).toHaveLength(FN_FACET_LIMIT);
      const last = `fn-${String(FN_FIXTURE_COUNT).padStart(2, "0")}`;
      expect(shown.map((f) => f.value)).not.toContain(last);

      const selected = await runGlobalSearch(db(), scope(), parseSearch(["ronquillo"]), {
        category: "entities",
        page: 1,
        facets: { fns: [last] },
        sort: null,
      });
      const withSelection = selected.facetCounts.fns ?? [];
      expect(withSelection).toHaveLength(FN_FACET_LIMIT + 1);
      expect(withSelection[withSelection.length - 1]).toEqual({
        value: last,
        count: 1,
      });
      expect(selected.page?.total).toBe(1);
    });
  });

  describe("pagination", () => {
    it("fills the first page and leaves the remainder for the second", async () => {
      const first = await runGlobalSearch(db(), scope(), parseSearch(["paginacion"]), {
        category: "descriptions",
        page: 1,
        facets: {},
        sort: null,
      });
      expect(first.page?.pageNumber).toBe(1);
      expect(first.page?.total).toBe(PAGINATION_ROWS);
      expect(first.page?.rows).toHaveLength(SEARCH_PAGE_SIZE);

      const second = await runGlobalSearch(db(), scope(), parseSearch(["paginacion"]), {
        category: "descriptions",
        page: 2,
        facets: {},
        sort: null,
      });
      expect(second.page?.pageNumber).toBe(2);
      expect(second.page?.total).toBe(PAGINATION_ROWS);
      expect(second.page?.rows).toHaveLength(PAGINATION_ROWS - SEARCH_PAGE_SIZE);

      // The second page is the remainder, not a repeat of the first.
      const firstIds = new Set(pageIds(first.page?.rows));
      const secondIds = pageIds(second.page?.rows);
      expect(secondIds.filter((id) => firstIds.has(id))).toEqual([]);
    });

    it("returns an empty page past the end without claiming a smaller total", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["paginacion"]), {
        category: "descriptions",
        page: 4,
        facets: {},
        sort: null,
      });
      expect(result.page?.rows).toEqual([]);
      expect(result.page?.total).toBe(PAGINATION_ROWS);
    });
  });

  describe("what a person actually types", () => {
    it("answers a blank combined view with the sidebar and no reads", async () => {
      const fromNull = await runGlobalSearch(db(), scope(), null, { category: "all" });
      expect(fromNull.mode).toBe("browse");
      expect(fromNull.counts).toEqual({});
      expect(fromNull.preview).toBeUndefined();
      expect(fromNull.page).toBeUndefined();
      expect((fromNull.facetCounts.levels ?? []).length).toBeGreaterThan(0);

      const fromBlank = await runGlobalSearch(db(), scope(), parseSearch(["   "]), {
        category: "all",
      });
      expect(fromBlank.counts).toEqual({});
      expect(fromBlank.mode).toBe("browse");
    });

    it("recovers a match from an unbalanced quote", async () => {
      // Phrase mode passes the raw typing through, so the first
      // attempt fails and the sanitised retry answers; the spy just
      // keeps the expected first-attempt log out of the test output.
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await runGlobalSearch(db(), scope(), parseSearch(['"bautismos']), {
          category: "all",
        });
        expect(result.counts.descriptions).toBe(1);
        expect(result.preview?.descriptions.map((r) => r.id)).toEqual([D_SCOPE]);
      } finally {
        logged.mockRestore();
      }
    });

    it("honours a balanced exact phrase", async () => {
      const phrase = await runGlobalSearch(db(), scope(), parseSearch(['"libro de bautismos"']), {
        category: "all",
      });
      expect(phrase.counts.descriptions).toBe(1);
      const absent = await runGlobalSearch(db(), scope(), parseSearch(['"bautismos de libro"']), {
        category: "all",
      });
      expect(absent.counts.descriptions).toBe(0);
    });

    it("degrades a stray colon to an empty answer instead of throwing", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // Compilation quotes the token, so the colon is plain text: a
        // clean zero-match answer, no error path involved.
        const result = await runGlobalSearch(db(), scope(), parseSearch(["a:b"]), {
          category: "all",
        });
        expect(result.counts.descriptions).toBe(0);
        expect(result.counts.entities).toBe(0);
        expect(result.counts.places).toBe(0);
        expect(result.preview?.descriptions).toEqual([]);
      } finally {
        logged.mockRestore();
      }
    });

    it("logs rather than swallowing a match it cannot run at all", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // A lone double quote enters phrase mode, so the raw typing
        // reaches FTS5 and fails as an unterminated string; stripping
        // it for the retry leaves nothing to search for. (A bare
        // colon, the old probe here, now parses to a blank query and
        // never reaches the database at all.)
        const result = await runGlobalSearch(db(), scope(), parseSearch(['"']), {
          category: "descriptions",
          page: 1,
          facets: {},
          sort: null,
        });
        expect(result.page?.rows).toEqual([]);
        expect(result.page?.total).toBe(0);
        expect(logged).toHaveBeenCalled();
      } finally {
        logged.mockRestore();
      }
    });
  });

  describe("refinements, exclusions, and field scopes", () => {
    it("removes an excluded term's row from rows and counts alike", async () => {
      const result = await runGlobalSearch(
        db(),
        scope(),
        parseSearch(["cofradia -rosario"]),
        { category: "all" },
      );
      expect(result.counts.descriptions).toBe(2);
      const ids = (result.preview?.descriptions ?? []).map((r) => r.id);
      expect(ids.sort()).toEqual([D_COFRADIA_ITEM, D_COFRADIA_REPO_TWO].sort());
      expect(ids).not.toContain(D_COFRADIA_FILE);
    });

    it("treats a NOT refinement q value exactly like the box's hyphen", async () => {
      const result = await runGlobalSearch(
        db(),
        scope(),
        parseSearch(["cofradia", "-rosario"]),
        { category: "all" },
      );
      expect(result.counts.descriptions).toBe(2);
      const ids = (result.preview?.descriptions ?? []).map((r) => r.id);
      expect(ids.sort()).toEqual([D_COFRADIA_ITEM, D_COFRADIA_REPO_TWO].sort());
    });

    it("subtracts exclusions from the name indexes too", async () => {
      // The compiled exclusion is column-free, so the same expression
      // narrows entities exactly as it narrows records.
      const result = await runGlobalSearch(
        db(),
        scope(),
        parseSearch(["chitagoza -beatriz"]),
        { category: "all" },
      );
      expect(result.counts.entities).toBe(1);
      expect((result.preview?.entities ?? []).map((r) => r.id)).toEqual([
        E_SHARED,
      ]);
    });

    it("scopes a field refinement to its column and blanks the authority tabs", async () => {
      // "mision" lives in D_PADRON's title and in D_SCOPE's scope and
      // content, so the unscoped query finds both; scoped to the title
      // column, only the title match survives — and the name indexes,
      // which have no such column, go ABSENT rather than answering.
      const result = await runGlobalSearch(
        db(),
        scope(),
        parseSearch(["mision", "title:mision"]),
        { category: "all" },
      );
      expect(result.counts.descriptions).toBe(1);
      expect((result.preview?.descriptions ?? []).map((r) => r.id)).toEqual([
        D_PADRON,
      ]);
      expect(result.counts).not.toHaveProperty("entities");
      expect(result.counts).not.toHaveProperty("places");
      expect(result.preview?.entities).toEqual([]);
      expect(result.preview?.places).toEqual([]);
      expect(result.facetCounts).not.toHaveProperty("entityTypes");
      expect(result.facetCounts).not.toHaveProperty("placeTypes");
    });

    it("keeps authority counts absent on the field-scoped records view", async () => {
      const result = await runGlobalSearch(
        db(),
        scope(),
        parseSearch(["mision", "title:mision"]),
        { category: "descriptions", page: 1, facets: {}, sort: null },
      );
      expect(result.counts.descriptions).toBe(1);
      expect(result.counts).not.toHaveProperty("entities");
      expect(result.counts).not.toHaveProperty("places");
      expect(result.page?.total).toBe(1);
    });

    it("refuses an authority view the field coercion should have caught", async () => {
      await expect(
        runGlobalSearch(db(), scope(), parseSearch(["chitagoza", "title:mision"]), {
          category: "entities",
          page: 1,
          facets: {},
          sort: null,
        }),
      ).rejects.toThrow(/authorities/i);
    });

    it("matches a multi-word refinement as an ordered phrase", async () => {
      const inOrder = await runGlobalSearch(
        db(),
        scope(),
        parseSearch(["registro", "visitas pastorales"]),
        { category: "all" },
      );
      expect(inOrder.counts.descriptions).toBe(1);
      expect((inOrder.preview?.descriptions ?? []).map((r) => r.id)).toEqual([
        D_SCOPE,
      ]);
      const reversed = await runGlobalSearch(
        db(),
        scope(),
        parseSearch(["registro", "pastorales visitas"]),
        { category: "all" },
      );
      expect(reversed.counts.descriptions).toBe(0);
    });

    it("searches FTS5 keywords and hyphenated terms as ordinary text", async () => {
      // Unquoted, `sub-fondo` and a bare `AND` are FTS5 syntax errors;
      // quoted compilation makes both plain searchable terms, so no
      // error path — and no console noise — is involved.
      await seedDescription({
        id: "9c000000-0000-4000-8000-00000000hyph",
        tenantId: TENANT_A,
        repositoryId: REPO_ONE,
        referenceCode: "SBM-091",
        title: "Cuaderno del sub-fondo escriturario",
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const hyphenated = await runGlobalSearch(
          db(),
          scope(),
          parseSearch(["sub-fondo"]),
          { category: "all" },
        );
        expect(hyphenated.counts.descriptions).toBe(1);
        expect(
          (hyphenated.preview?.descriptions ?? []).map((r) => r.referenceCode),
        ).toEqual(["SBM-091"]);
        const keyword = await runGlobalSearch(db(), scope(), parseSearch(["AND"]), {
          category: "all",
        });
        expect(keyword.counts.descriptions).toBe(0);
        expect(logged).not.toHaveBeenCalled();
      } finally {
        logged.mockRestore();
      }
    });
  });

  describe("browse mode", () => {
    it("answers a facet-only view with rows, an honest total, and plain titles", async () => {
      const result = await runGlobalSearch(db(), scope(), null, {
        category: "descriptions",
        page: 1,
        facets: { repoIds: [REPO_THREE] },
        sort: null,
      });
      expect(result.mode).toBe("browse");
      expect(result.page?.total).toBe(3);
      // The browse default is code ascending.
      expect(pageIds(result.page?.rows)).toEqual([
        D_BROWSE_BRAVO,
        D_BROWSE_CHARLIE,
        D_BROWSE_ALPHA,
      ]);
      const rows = result.page?.rows as DescriptionHit[];
      for (const row of rows) {
        expect(row.scopeSnippet).toBeNull();
        expect(markedTerms(row.titleMarked)).toEqual([]);
      }
      expect(rows.map((r) => r.titleMarked)).toEqual([
        "Bravo expediente",
        "charlie expediente",
        "alpha expediente",
      ]);
    });

    it("keeps the tenant boundary with no MATCH clause to hide behind", async () => {
      const mine = await runGlobalSearch(db(), scope(), null, {
        category: "descriptions",
        page: 1,
        facets: { repoIds: [REPO_THREE] },
        sort: null,
      });
      expect(pageIds(mine.page?.rows)).not.toContain(D_OTHER_BROWSE);

      // Another tenant's repository id, handed in as a facet, narrows
      // to nothing rather than reaching across the boundary.
      const foreign = await runGlobalSearch(db(), scope(), null, {
        category: "descriptions",
        page: 1,
        facets: { repoIds: [REPO_OTHER] },
        sort: null,
      });
      expect(foreign.page?.total).toBe(0);
      expect(foreign.page?.rows).toEqual([]);

      // And the other tenant browsing sees exactly its own two records.
      const theirs = await runGlobalSearch(
        db(),
        scope({ tenantId: TENANT_B, federationId: FED_B }),
        null,
        { category: "descriptions", page: 1, facets: {}, sort: null },
      );
      expect(theirs.page?.total).toBe(2);
      expect(pageIds(theirs.page?.rows).sort()).toEqual(
        [D_OTHER_TENANT, D_OTHER_BROWSE].sort(),
      );
    });

    it("pages the whole scoped category when the facets are cleared", async () => {
      const everything = await runGlobalSearch(db(), scope(), parseSearch([""]), {
        category: "descriptions",
        page: 1,
        facets: {},
        sort: null,
      });
      expect(everything.mode).toBe("browse");
      expect(everything.page?.total).toBeGreaterThan(SEARCH_PAGE_SIZE);
      expect(everything.page?.rows).toHaveLength(SEARCH_PAGE_SIZE);
      expect(pageIds(everything.page?.rows)).not.toContain(D_OTHER_TENANT);
    });

    it("answers an exclusion-only query by subtracting from the scoped read", async () => {
      const baseline = await runGlobalSearch(db(), scope(), null, {
        category: "descriptions",
        page: 1,
        facets: {},
        sort: null,
      });
      const minus = await runGlobalSearch(db(), scope(), parseSearch(["-charlie"]), {
        category: "descriptions",
        page: 1,
        facets: {},
        sort: null,
      });
      expect(minus.mode).toBe("browse");
      expect(minus.page?.total).toBe((baseline.page?.total ?? 0) - 1);
      expect(minus.counts.descriptions).toBe((baseline.counts.descriptions ?? 0) - 1);

      // Narrowed to the browse repository, the missing row is visible.
      const inRepo = await runGlobalSearch(db(), scope(), parseSearch(["-charlie"]), {
        category: "descriptions",
        page: 1,
        facets: { repoIds: [REPO_THREE] },
        sort: null,
      });
      expect(inRepo.page?.total).toBe(2);
      expect(pageIds(inRepo.page?.rows)).not.toContain(D_BROWSE_CHARLIE);
    });

    it("subtracts from the name indexes while keeping the authority scope", async () => {
      const baseline = await runGlobalSearch(db(), scope(), null, {
        category: "entities",
        page: 1,
        facets: {},
        sort: null,
      });
      const minus = await runGlobalSearch(db(), scope(), parseSearch(["-beatriz"]), {
        category: "entities",
        page: 1,
        facets: {},
        sort: null,
      });
      expect(minus.mode).toBe("browse");
      expect(minus.counts.entities).toBe((baseline.counts.entities ?? 0) - 1);
      const ids = pageIds(minus.page?.rows);
      expect(ids).not.toContain(E_OWN);
      // The exclusion removes rows; it never widens what is visible.
      expect(ids).not.toContain(E_SIBLING);
      expect(ids).not.toContain(E_OTHER_FED);
      expect(ids).not.toContain(E_MERGED);
      expect(ids).toContain(E_SHARED);
    });

    it("answers the combined view by browsing every category at once", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["-charlie"]), {
        category: "all",
      });
      expect(result.mode).toBe("browse");
      expect(result.counts.descriptions).toBeGreaterThan(0);
      expect(result.counts.entities).toBeGreaterThan(0);
      expect(result.counts.places).toBe(2);
      const rows = result.preview?.descriptions ?? [];
      expect(rows).toHaveLength(SEARCH_PREVIEW_LIMIT);
      for (const row of rows) expect(row.scopeSnippet).toBeNull();
      expect(rows.map((r) => r.id)).not.toContain(D_BROWSE_CHARLIE);
    });

    it("counts the sidebar under the browse predicate, exclusions included", async () => {
      const result = await runGlobalSearch(db(), scope(), parseSearch(["-charlie"]), {
        category: "descriptions",
        page: 1,
        facets: { repoIds: [REPO_THREE] },
        sort: null,
      });
      // Own group short-circuited, so the repository group counts the
      // two survivors in the browse repository.
      expect(result.facetCounts.repositories).toEqual(
        expect.arrayContaining([
          { id: REPO_THREE, name: "Repository GS-THR", count: 2 },
        ]),
      );
      // The level group feels the repository selection.
      expect(result.facetCounts.levels).toEqual([
        { value: "file", count: 1 },
        { value: "item", count: 1 },
      ]);
    });

    it("returns the landing sidebar with corpus-wide, scoped numbers", async () => {
      const landing = await runGlobalSearch(db(), scope(), null, { category: "all" });
      const everything = await runGlobalSearch(db(), scope(), null, {
        category: "descriptions",
        page: 1,
        facets: {},
        sort: null,
      });
      const total = everything.page?.total ?? 0;
      const levels = landing.facetCounts.levels ?? [];
      const repositories = landing.facetCounts.repositories ?? [];
      expect(levels.reduce((sum, entry) => sum + entry.count, 0)).toBe(total);
      expect(repositories.reduce((sum, entry) => sum + entry.count, 0)).toBe(total);
      expect(repositories.map((r) => r.id).sort()).toEqual(
        [REPO_ONE, REPO_TWO, REPO_THREE, REPO_FOUR].sort(),
      );
      expect(repositories.map((r) => r.id)).not.toContain(REPO_OTHER);
      expect(landing.facetCounts.entityTypes).toBeDefined();
      expect(landing.facetCounts.placeTypes).toEqual([
        { value: "parish", count: 1 },
        { value: "town", count: 1 },
      ]);
    });
  });

  describe("sorting", () => {
    const browseThree = {
      category: "descriptions" as const,
      page: 1,
      facets: { repoIds: [REPO_THREE] },
    };

    it("orders records by date, missing dates last in both directions", async () => {
      const asc = await runGlobalSearch(db(), scope(), null, {
        ...browseThree,
        sort: { key: "date", dir: "asc" },
      });
      expect(pageIds(asc.page?.rows)).toEqual([
        D_BROWSE_BRAVO,
        D_BROWSE_ALPHA,
        D_BROWSE_CHARLIE,
      ]);
      const desc = await runGlobalSearch(db(), scope(), null, {
        ...browseThree,
        sort: { key: "date", dir: "desc" },
      });
      expect(pageIds(desc.page?.rows)).toEqual([
        D_BROWSE_ALPHA,
        D_BROWSE_BRAVO,
        D_BROWSE_CHARLIE,
      ]);
    });

    it("orders records by title without minding capitals", async () => {
      const asc = await runGlobalSearch(db(), scope(), null, {
        ...browseThree,
        sort: { key: "title", dir: "asc" },
      });
      expect(pageIds(asc.page?.rows)).toEqual([
        D_BROWSE_ALPHA,
        D_BROWSE_BRAVO,
        D_BROWSE_CHARLIE,
      ]);
      const desc = await runGlobalSearch(db(), scope(), null, {
        ...browseThree,
        sort: { key: "title", dir: "desc" },
      });
      expect(pageIds(desc.page?.rows)).toEqual([
        D_BROWSE_CHARLIE,
        D_BROWSE_BRAVO,
        D_BROWSE_ALPHA,
      ]);
    });

    it("orders records by reference code", async () => {
      const asc = await runGlobalSearch(db(), scope(), null, {
        ...browseThree,
        sort: { key: "code", dir: "asc" },
      });
      expect(pageIds(asc.page?.rows)).toEqual([
        D_BROWSE_BRAVO,
        D_BROWSE_CHARLIE,
        D_BROWSE_ALPHA,
      ]);
      const desc = await runGlobalSearch(db(), scope(), null, {
        ...browseThree,
        sort: { key: "code", dir: "desc" },
      });
      expect(pageIds(desc.page?.rows)).toEqual([
        D_BROWSE_ALPHA,
        D_BROWSE_CHARLIE,
        D_BROWSE_BRAVO,
      ]);
    });

    it("falls back to code ascending when relevance is asked for while browsing", async () => {
      const result = await runGlobalSearch(db(), scope(), null, {
        ...browseThree,
        sort: { key: "relevance", dir: "desc" },
      });
      expect(pageIds(result.page?.rows)).toEqual([
        D_BROWSE_BRAVO,
        D_BROWSE_CHARLIE,
        D_BROWSE_ALPHA,
      ]);
    });

    it("sorts a matched result set too, instead of ranking it", async () => {
      const byTitle = await runGlobalSearch(db(), scope(), parseSearch(["expediente"]), {
        category: "descriptions",
        page: 1,
        facets: { repoIds: [REPO_THREE] },
        sort: { key: "title", dir: "desc" },
      });
      expect(byTitle.mode).toBe("match");
      expect(pageIds(byTitle.page?.rows)).toEqual([
        D_BROWSE_CHARLIE,
        D_BROWSE_BRAVO,
        D_BROWSE_ALPHA,
      ]);
    });

    it("orders authorities by name and by code, codeless records last", async () => {
      const byName = await runGlobalSearch(db(), scope(), parseSearch(["quiroga"]), {
        category: "entities",
        page: 1,
        facets: {},
        sort: { key: "name", dir: "asc" },
      });
      expect(pageIds(byName.page?.rows)).toEqual([
        E_SORT_ANA,
        E_SORT_BRUNA,
        E_SORT_CARLOS,
      ]);
      const byNameDesc = await runGlobalSearch(db(), scope(), parseSearch(["quiroga"]), {
        category: "entities",
        page: 1,
        facets: {},
        sort: { key: "name", dir: "desc" },
      });
      expect(pageIds(byNameDesc.page?.rows)).toEqual([
        E_SORT_CARLOS,
        E_SORT_BRUNA,
        E_SORT_ANA,
      ]);

      const byCode = await runGlobalSearch(db(), scope(), parseSearch(["quiroga"]), {
        category: "entities",
        page: 1,
        facets: {},
        sort: { key: "code", dir: "asc" },
      });
      expect(pageIds(byCode.page?.rows)).toEqual([
        E_SORT_ANA,
        E_SORT_BRUNA,
        E_SORT_CARLOS,
      ]);
      const byCodeDesc = await runGlobalSearch(db(), scope(), parseSearch(["quiroga"]), {
        category: "entities",
        page: 1,
        facets: {},
        sort: { key: "code", dir: "desc" },
      });
      // The codeless record stays last whichever way the codes run.
      expect(pageIds(byCodeDesc.page?.rows)).toEqual([
        E_SORT_BRUNA,
        E_SORT_ANA,
        E_SORT_CARLOS,
      ]);
    });

    it("ignores a sort key the category does not have", async () => {
      // "name" is a name-index key; asking the record index for it
      // resolves to the mode's default rather than failing.
      const result = await runGlobalSearch(db(), scope(), null, {
        ...browseThree,
        sort: { key: "name", dir: "desc" },
      });
      expect(pageIds(result.page?.rows)).toEqual([
        D_BROWSE_BRAVO,
        D_BROWSE_CHARLIE,
        D_BROWSE_ALPHA,
      ]);
    });
  });

  describe("the advanced grammar against the real index", () => {
    it("unions two records with OR, neither of which answers both terms", async () => {
      const either = await runGlobalSearch(
        db(),
        scope(),
        [row("and", null, "zipacon"), row("or", null, "sogamoso")],
        { category: "all" },
      );
      expect(either.mode).toBe("match");
      expect(either.counts.descriptions).toBe(2);
      expect((either.preview?.descriptions ?? []).map((r) => r.id).sort()).toEqual(
        [D_ADV_TEQ, D_ADV_SOG].sort(),
      );

      // The same two rows joined with AND find nothing at all, which is
      // what makes the union above the OR's own doing.
      const both = await runGlobalSearch(
        db(),
        scope(),
        [row("and", null, "zipacon"), row("and", null, "sogamoso")],
        { category: "all" },
      );
      expect(both.counts.descriptions).toBe(0);
    });

    it("subtracts with NOT, and keeps subtracting down a chain", async () => {
      const all = await runGlobalSearch(db(), scope(), [row("and", null, "sutatausa")], {
        category: "all",
      });
      expect(all.counts.descriptions).toBe(4);

      const minusOne = await runGlobalSearch(
        db(),
        scope(),
        [row("and", null, "sutatausa"), row("not", null, "guatavita")],
        { category: "all" },
      );
      expect((minusOne.preview?.descriptions ?? []).map((r) => r.id).sort()).toEqual(
        [D_ADV_TEQ, D_ADV_SOG].sort(),
      );

      const minusTwo = await runGlobalSearch(
        db(),
        scope(),
        [
          row("and", null, "sutatausa"),
          row("not", null, "guatavita"),
          row("not", null, "sogamoso"),
        ],
        { category: "all" },
      );
      expect((minusTwo.preview?.descriptions ?? []).map((r) => r.id)).toEqual([
        D_ADV_TEQ,
      ]);
    });

    it("reads a OR b NOT c left-associatively, as (a OR b) NOT c", async () => {
      // D_ADV_TEQ_GUA holds `tequendama` AND `guatavita`, and it is the
      // one record the two readings disagree about: left-associatively
      // the trailing NOT subtracts it from the whole union, while
      // right-associatively — a OR (b NOT c) — the leading OR would put
      // it straight back. Its ABSENCE is the proof.
      const rows = [
        row("and", null, "tequendama"),
        row("or", null, "sogamoso"),
        row("not", null, "guatavita"),
      ];
      const result = await runGlobalSearch(db(), scope(), rows, { category: "all" });
      expect(result.counts.descriptions).toBe(2);
      const ids = (result.preview?.descriptions ?? []).map((r) => r.id);
      expect(ids.sort()).toEqual([D_ADV_TEQ, D_ADV_SOG].sort());
      expect(ids).not.toContain(D_ADV_TEQ_GUA);

      // The union itself does contain it, so the exclusion above is the
      // NOT working and not the OR having missed the record.
      const union = await runGlobalSearch(db(), scope(), rows.slice(0, 2), {
        category: "all",
      });
      expect((union.preview?.descriptions ?? []).map((r) => r.id)).toContain(
        D_ADV_TEQ_GUA,
      );
    });

    it("honours a starred row and a multi-word row against the index", async () => {
      const starred = await runGlobalSearch(
        db(),
        scope(),
        [row("and", null, "casa*")],
        { category: "all" },
      );
      expect(starred.counts.descriptions).toBe(2);
      const phrase = await runGlobalSearch(
        db(),
        scope(),
        [row("and", null, "visitas pastorales")],
        { category: "all" },
      );
      expect((phrase.preview?.descriptions ?? []).map((r) => r.id)).toEqual([D_SCOPE]);
      const reversed = await runGlobalSearch(
        db(),
        scope(),
        [row("and", null, "pastorales visitas")],
        { category: "all" },
      );
      expect(reversed.counts.descriptions).toBe(0);
    });

    it("scopes a field row to its column and blanks the authority tabs", async () => {
      // `chiscas` lives in one record's title and another's scope and
      // content, so the unscoped row finds both.
      const unscoped = await runGlobalSearch(
        db(),
        scope(),
        [row("and", null, "chiscas")],
        { category: "all" },
      );
      expect(unscoped.counts.descriptions).toBe(2);
      expect(unscoped.counts.entities).toBe(0);
      expect(unscoped.counts.places).toBe(0);

      const scoped = await runGlobalSearch(
        db(),
        scope(),
        [row("and", "title", "chiscas")],
        { category: "all" },
      );
      expect(scoped.counts.descriptions).toBe(1);
      expect((scoped.preview?.descriptions ?? []).map((r) => r.id)).toEqual([
        D_ADV_TITLE,
      ]);
      // The name indexes have no such column, so they go ABSENT rather
      // than being sent a filter they would reject.
      expect(scoped.counts).not.toHaveProperty("entities");
      expect(scoped.counts).not.toHaveProperty("places");
      expect(scoped.preview?.entities).toEqual([]);
      expect(scoped.preview?.places).toEqual([]);
      expect(scoped.facetCounts).not.toHaveProperty("entityTypes");
      expect(scoped.facetCounts).not.toHaveProperty("fns");
      expect(scoped.facetCounts).not.toHaveProperty("placeTypes");
    });

    it("keeps authority counts absent on a field-scoped records page", async () => {
      const result = await runGlobalSearch(
        db(),
        scope(),
        [row("and", "title", "chiscas")],
        { category: "descriptions", page: 1, facets: {}, sort: null },
      );
      expect(result.page?.total).toBe(1);
      expect(result.counts).not.toHaveProperty("entities");
      expect(result.counts).not.toHaveProperty("places");
    });

    it("refuses an authority view a field row should have coerced away", async () => {
      await expect(
        runGlobalSearch(
          db(),
          scope(),
          [row("and", null, "chitagoza"), row("or", "title", "chiscas")],
          { category: "entities", page: 1, facets: {}, sort: null },
        ),
      ).rejects.toThrow(/authorities/i);
    });

    it("asks the name indexes too when no row carries a field", async () => {
      const result = await runGlobalSearch(
        db(),
        scope(),
        [row("and", null, "chitagoza"), row("or", null, "guasca")],
        { category: "all" },
      );
      expect(result.counts.descriptions).toBe(0);
      expect(result.counts.entities).toBe(2);
      expect(result.counts.places).toBe(2);
      expect((result.preview?.entities ?? []).map((r) => r.id).sort()).toEqual(
        [E_SHARED, E_OWN].sort(),
      );
      expect((result.preview?.places ?? []).map((r) => r.id).sort()).toEqual(
        [P_SHARED, P_OWN].sort(),
      );
      // The authority boundary is the same one browsing and matching
      // hold: an OR widens the terms, never the scope.
      const entityIds = (result.preview?.entities ?? []).map((r) => r.id);
      expect(entityIds).not.toContain(E_SIBLING);
      expect(entityIds).not.toContain(E_OTHER_FED);
      expect(entityIds).not.toContain(E_MERGED);
    });

    it("keeps the tenant boundary on an advanced match", async () => {
      const mine = await runGlobalSearch(db(), scope(), [row("and", null, "bautismos")], {
        category: "all",
      });
      expect((mine.preview?.descriptions ?? []).map((r) => r.id)).toEqual([D_SCOPE]);
      expect((mine.preview?.descriptions ?? []).map((r) => r.id)).not.toContain(
        D_OTHER_TENANT,
      );
    });

    it("answers an empty row list the way it answers a blank box", async () => {
      const landing = await runGlobalSearch(db(), scope(), [], { category: "all" });
      expect(landing.mode).toBe("browse");
      expect(landing.counts).toEqual({});
      expect(landing.preview).toBeUndefined();
      expect((landing.facetCounts.levels ?? []).length).toBeGreaterThan(0);

      // With a facet narrowing, the same empty list browses instead.
      const browsing = await runGlobalSearch(db(), scope(), [], {
        category: "descriptions",
        page: 1,
        facets: { repoIds: [REPO_FOUR] },
        sort: null,
      });
      expect(browsing.mode).toBe("browse");
      expect(browsing.page?.total).toBe(DATE_FIXTURE_COUNT);
    });

    it("pages and sorts an advanced result set like any other", async () => {
      const result = await runGlobalSearch(
        db(),
        scope(),
        [row("and", null, "sutatausa")],
        {
          category: "descriptions",
          page: 1,
          facets: {},
          sort: { key: "code", dir: "desc" },
        },
      );
      expect(result.page?.total).toBe(4);
      expect(pageIds(result.page?.rows)).toEqual([
        D_ADV_TEQ_GUA,
        D_ADV_GUA,
        D_ADV_SOG,
        D_ADV_TEQ,
      ]);
    });

    it("runs the rows a crafted URL actually parsed to", async () => {
      const rows = parseAdvancedRows([
        "not::tequendama",
        "bogus::ignored",
        "or:creator:ignored",
        "or::sogamoso",
        "not::guatavita",
      ]);
      // The leading exclusion and the two junk rows fell away, so
      // sogamoso anchors and what runs is (sogamoso) NOT guatavita.
      expect(rows).toEqual([
        row("and", null, "sogamoso"),
        row("not", null, "guatavita"),
      ]);
      const result = await runGlobalSearch(db(), scope(), rows, { category: "all" });
      expect((result.preview?.descriptions ?? []).map((r) => r.id).sort()).toEqual(
        [D_ADV_SOG].sort(),
      );
    });
  });

  describe("the date range, as an overlap", () => {
    const inRepoFour = {
      category: "descriptions" as const,
      page: 1,
      sort: null,
    };

    async function datedIds(
      dateFrom: string | null,
      dateTo: string | null,
    ): Promise<string[]> {
      const result = await runGlobalSearch(db(), scope(), null, {
        ...inRepoFour,
        facets: { repoIds: [REPO_FOUR], dateFrom, dateTo },
      });
      return pageIds(result.page?.rows).sort();
    }

    it("keeps every span that meets the range and drops every span that misses", async () => {
      // Inside, straddling either edge, and containing the range whole
      // all overlap; the two disjoint spans and the undated record do
      // not. The record whose end date is the empty string a cleared
      // field leaves behind is read as single-dated, not as blank.
      expect(await datedIds("1650", "1700")).toEqual(
        [
          D_DATE_INSIDE,
          D_DATE_STRADDLE_START,
          D_DATE_STRADDLE_END,
          D_DATE_CONTAINING,
          D_DATE_EMPTY_END,
        ].sort(),
      );
    });

    it("excludes a record with no start date while a bound is active", async () => {
      expect(await datedIds("1650", "1700")).not.toContain(D_DATE_NONE);
      expect(await datedIds("1650", null)).not.toContain(D_DATE_NONE);
      expect(await datedIds(null, "1700")).not.toContain(D_DATE_NONE);
      // With no bound at all it is an ordinary record again.
      const unbounded = await runGlobalSearch(db(), scope(), null, {
        ...inRepoFour,
        facets: { repoIds: [REPO_FOUR] },
      });
      expect(unbounded.page?.total).toBe(DATE_FIXTURE_COUNT);
      expect(pageIds(unbounded.page?.rows)).toContain(D_DATE_NONE);
    });

    it("answers an open-ended range from either side", async () => {
      expect(await datedIds("1700", null)).toEqual(
        [D_DATE_STRADDLE_END, D_DATE_CONTAINING, D_DATE_AFTER].sort(),
      );
      expect(await datedIds(null, "1600")).toEqual(
        [
          D_DATE_STRADDLE_START,
          D_DATE_CONTAINING,
          D_DATE_BEFORE,
          D_DATE_YEAR_ONLY,
        ].sort(),
      );
    });

    it("places a year-only date inside a range that begins in its year", async () => {
      // The lower bound compares years, not full ISO strings — a
      // lexicographic compare would deny '1580' >= '1580-01-01' and
      // silently truncate the low end of every range for the 429 live
      // records dated this way.
      expect(await datedIds("1580", "1600")).toContain(D_DATE_YEAR_ONLY);
      expect(await datedIds("1580", null)).toContain(D_DATE_YEAR_ONLY);
    });

    it("keeps an empty-string start date out of every bounded range", async () => {
      // '' would compare before every bound; NULLIF folds it into the
      // same absence as NULL, so the record is unplaceable rather than
      // everywhere.
      expect(await datedIds(null, "1600")).not.toContain(D_DATE_EMPTY_START);
      expect(await datedIds("1650", "1700")).not.toContain(D_DATE_EMPTY_START);
      expect(await datedIds("1650", null)).not.toContain(D_DATE_EMPTY_START);
    });

    it("reads a single year as the whole of that year", async () => {
      // 1660 catches the span that ends on its first day and the one
      // that starts on it, which is what a year-granular overlap means.
      expect(await datedIds("1660", "1660")).toEqual(
        [
          D_DATE_INSIDE,
          D_DATE_STRADDLE_START,
          D_DATE_CONTAINING,
          D_DATE_EMPTY_END,
        ].sort(),
      );
    });

    it("narrows a matched query as readily as a browsed one", async () => {
      const all = await runGlobalSearch(db(), scope(), parseSearch(["tibasosa"]), {
        category: "descriptions",
        page: 1,
        facets: {},
        sort: null,
      });
      expect(all.mode).toBe("match");
      expect(all.page?.total).toBe(DATE_FIXTURE_COUNT);

      const dated = await runGlobalSearch(db(), scope(), parseSearch(["tibasosa"]), {
        category: "descriptions",
        page: 1,
        facets: { dateFrom: "1650", dateTo: "1700" },
        sort: null,
      });
      expect(dated.page?.total).toBe(5);
      // The tab number stays facet-free, as it does for every facet.
      expect(dated.counts.descriptions).toBe(DATE_FIXTURE_COUNT);
    });

    it("narrows an advanced query too", async () => {
      const dated = await runGlobalSearch(
        db(),
        scope(),
        [row("and", null, "tibasosa"), row("not", null, "posterior")],
        {
          category: "descriptions",
          page: 1,
          facets: { dateFrom: "1700", dateTo: "1900" },
          sort: null,
        },
      );
      // `posterior` is D_DATE_AFTER, the one the NOT removes; what is
      // left of the 1700-1900 window is the two spans that reach into it.
      expect(pageIds(dated.page?.rows).sort()).toEqual(
        [D_DATE_STRADDLE_END, D_DATE_CONTAINING].sort(),
      );
    });

    it("blanks the authority categories, the way a field scope does", async () => {
      const result = await runGlobalSearch(db(), scope(), null, {
        category: "descriptions",
        page: 1,
        facets: { repoIds: [REPO_FOUR], dateFrom: "1650", dateTo: "1700" },
        sort: null,
      });
      expect(result.page?.total).toBe(5);
      expect(result.counts).not.toHaveProperty("entities");
      expect(result.counts).not.toHaveProperty("places");
      expect(result.facetCounts).not.toHaveProperty("entityTypes");
      expect(result.facetCounts).not.toHaveProperty("fns");
      expect(result.facetCounts).not.toHaveProperty("placeTypes");
      expect(result.facetCounts.levels).toBeDefined();
      expect(result.facetCounts.repositories).toBeDefined();
    });

    it("blanks them on one bound alone as readily as on two", async () => {
      const fromOnly = await runGlobalSearch(db(), scope(), null, {
        ...inRepoFour,
        facets: { repoIds: [REPO_FOUR], dateFrom: "1700" },
      });
      expect(fromOnly.counts).not.toHaveProperty("entities");
      const toOnly = await runGlobalSearch(db(), scope(), null, {
        ...inRepoFour,
        facets: { repoIds: [REPO_FOUR], dateTo: "1600" },
      });
      expect(toOnly.counts).not.toHaveProperty("places");
    });

    it("refuses an authority view a date bound should have coerced away", async () => {
      await expect(
        runGlobalSearch(db(), scope(), parseSearch(["chitagoza"]), {
          category: "entities",
          page: 1,
          facets: { dateFrom: "1650" },
          sort: null,
        }),
      ).rejects.toThrow(/authorities/i);
    });

    it("narrows the sidebar's counts, in both groups at once", async () => {
      const result = await runGlobalSearch(db(), scope(), null, {
        ...inRepoFour,
        facets: { repoIds: [REPO_FOUR], dateFrom: "1650", dateTo: "1700" },
      });
      // The level group short-circuits its OWN selections, never the
      // date: the five overlapping records, by level.
      expect(result.facetCounts.levels).toEqual([
        { value: "file", count: 2 },
        { value: "item", count: 2 },
        { value: "series", count: 1 },
      ]);
      // The repository group drops its own selection and keeps the
      // date, so the other repositories' undated records vanish rather
      // than reappearing as an unnarrowed count.
      expect(result.facetCounts.repositories).toEqual([
        { id: REPO_FOUR, name: "Repository GS-FOU", count: 5 },
      ]);
    });

    it("keeps the tenant boundary while a date narrows", async () => {
      const foreign = await runGlobalSearch(
        db(),
        scope({ tenantId: TENANT_B, federationId: FED_B }),
        null,
        {
          ...inRepoFour,
          facets: { repoIds: [REPO_FOUR], dateFrom: "1650", dateTo: "1700" },
        },
      );
      expect(foreign.page?.total).toBe(0);
      expect(foreign.page?.rows).toEqual([]);
    });
  });

  describe("heading mentions", () => {
    /** The heading the decisions surface would be holding. */
    const UBAQUE = "Cacicazgo de Ubaque";
    /** A heading no record says outright — the related tier's case. */
    const MOJONES = "Los mojones de Suba";

    it("finds the whole heading as one phrase, inside the tenant's own records", async () => {
      const { phrase, related } = await selectHeadingMentions(
        db(),
        scope(),
        UBAQUE,
        10,
      );
      expect(phrase.map((m) => m.id).sort()).toEqual(
        [D_HEAD_TITLE, D_HEAD_SCOPE].sort(),
      );
      // The sibling tenant's copy of the same heading is not evidence
      // for this tenant's ruling.
      expect(phrase.map((m) => m.id)).not.toContain(D_HEAD_SIBLING);
      // Each row carries enough to link to and to read.
      const titled = phrase.find((m) => m.id === D_HEAD_TITLE) as {
        referenceCode: string | null;
        title: string;
      };
      expect(titled.referenceCode).toBe("SBM-H01");
      expect(titled.title).toBe("Cacicazgo de Ubaque y su encomienda");
      // A phrase that answered has nothing to gain from a looser pass.
      expect(related).toEqual([]);
    });

    it("gives the sibling tenant its own record, and the other federation none", async () => {
      const theirs = await selectHeadingMentions(
        db(),
        scope({ tenantId: SIBLING_TENANT_ID }),
        UBAQUE,
        10,
      );
      expect(theirs.phrase.map((m) => m.id)).toEqual([D_HEAD_SIBLING]);

      const elsewhere = await selectHeadingMentions(
        db(),
        scope({ tenantId: TENANT_B, federationId: FED_B }),
        UBAQUE,
        10,
      );
      expect(elsewhere.phrase).toEqual([]);
      expect(elsewhere.related).toEqual([]);
    });

    it("falls back to the heading's substantial tokens only when the phrase found nothing", async () => {
      const { phrase, related } = await selectHeadingMentions(
        db(),
        scope(),
        MOJONES,
        10,
      );
      expect(phrase).toEqual([]);
      expect(related.map((m) => m.id)).toEqual([D_HEAD_RELATED]);
      // "Los" is three characters, so it never reached the expression:
      // the record whose only overlap with the heading is that word
      // stays out of the tier instead of flooding it.
      expect(related.map((m) => m.id)).not.toContain(D_HEAD_SHORT_ONLY);
    });

    it("has no related tier at all when every token is too short", async () => {
      const result = await selectHeadingMentions(db(), scope(), "Los de la sal", 10);
      expect(result.phrase).toEqual([]);
      expect(result.related).toEqual([]);
    });

    it("counts the phrase tier, and only the phrase tier", async () => {
      expect(await countHeadingMentions(db(), scope(), UBAQUE)).toBe(2);
      expect(
        await countHeadingMentions(db(), scope({ tenantId: SIBLING_TENANT_ID }), UBAQUE),
      ).toBe(1);
      // The related tier has a row for this heading; the number does
      // not, because the list it would explain is a different list.
      expect(await countHeadingMentions(db(), scope(), MOJONES)).toBe(0);
    });

    it("passes a heading with quotes and punctuation through as text, not as syntax", async () => {
      const quoted = 'Cofradía "del Rosario"';
      const result = await selectHeadingMentions(db(), scope(), quoted, 10);
      expect(result.phrase.map((m) => m.id)).toEqual([D_COFRADIA_FILE]);
      expect(await countHeadingMentions(db(), scope(), quoted)).toBe(1);

      // A heading with nothing indexable in it answers empty rather
      // than handing FTS5 a phrase it would reject as syntax.
      const punctuation = await selectHeadingMentions(db(), scope(), "—¿?—", 10);
      expect(punctuation.phrase).toEqual([]);
      expect(punctuation.related).toEqual([]);
      expect(await countHeadingMentions(db(), scope(), "—¿?—")).toBe(0);
    });
  });

  // The cross-tenant keystone cannot see this module: its globs do not
  // include it, and its scanner keys on Drizzle call shapes that raw
  // SQL never produces. This is the one module where a lost predicate
  // is a cross-tenant read, so it carries its own static guard: every
  // raw SQL template that reads a scoped table must spell the scope in
  // the same template. Browse mode multiplied those templates — the
  // counts below are floors, so a new statement may join the scan but
  // none may quietly leave it.
  describe("scope keystone (static)", () => {
    const source = Object.values(
      import.meta.glob("../../app/lib/global-search.server.ts", {
        query: "?raw",
        eager: true,
        import: "default",
      }),
    )[0] as string;

    // Template literals are the odd-numbered segments of a backtick
    // split -- crude but sufficient for a file that never nests them.
    const templates = source
      .split("`")
      .filter((_, i) => i % 2 === 1);

    it("every descriptions read carries tenant_id in the same statement", () => {
      const reads = templates.filter((s) => s.includes("FROM descriptions"));
      expect(reads.length).toBeGreaterThanOrEqual(5);
      for (const s of reads) expect(s).toContain("tenant_id =");
    });

    it("every authority read carries authorityScopeSql in the same statement", () => {
      const entityReads = templates.filter((s) => s.includes("FROM entities"));
      const placeReads = templates.filter((s) => s.includes("FROM places"));
      expect(entityReads.length).toBeGreaterThanOrEqual(5);
      expect(placeReads.length).toBeGreaterThanOrEqual(4);
      for (const s of [...entityReads, ...placeReads]) {
        expect(s).toContain("authorityScopeSql");
        expect(s).toContain("merged_into IS NULL");
      }
    });

    it("covers the browse statements, which have no index to join", () => {
      // A browse read is one whose FTS join is interpolated rather than
      // written out: the guard must be reading those templates too, not
      // only the ones with a MATCH in them.
      const browseable = templates.filter(
        (s) =>
          s.includes("FROM descriptions d${descriptionJoin(query)}") ||
          s.includes("FROM entities e${entityJoin(query)}") ||
          s.includes("FROM places p${placeJoin(query)}"),
      );
      expect(browseable.length).toBeGreaterThanOrEqual(11);
      for (const s of browseable) {
        expect(
          s.includes("tenant_id =") || s.includes("authorityScopeSql"),
        ).toBe(true);
      }
    });

    it("removes excluded rows through a subquery that cannot widen scope", () => {
      const subqueries = templates.filter((s) => s.includes("NOT IN (SELECT rowid"));
      expect(subqueries).toHaveLength(3);
      for (const s of subqueries) {
        expect(
          s.includes("tenant_id =") || s.includes("authorityScopeSql"),
        ).toBe(true);
      }
    });

    it("binds the date bounds rather than writing them into a statement", () => {
      // A year arrives from the URL and is handed over as a value; no
      // template may carry a date literal, and every date comparison
      // must interpolate a binding. The comparisons run on the year
      // substring, because the stored dates are not uniformly
      // day-precise.
      const dateClauses = templates.filter(
        (s) =>
          s.includes("substr(d.date_start, 1, 4)") ||
          s.includes("substr(COALESCE(NULLIF(d.date_end"),
      );
      expect(dateClauses).toHaveLength(2);
      for (const s of dateClauses) {
        expect(s).toMatch(/\$\{/);
        expect(s).not.toContain("-01-01");
        expect(s).not.toContain("-12-31");
      }
      // And the unplaceable guard (NULL or empty start) rides with
      // them rather than being left to a caller to remember.
      expect(
        templates.some((s) => s.includes("NULLIF(d.date_start, '') IS NOT NULL")),
      ).toBe(true);
    });
  });
});
