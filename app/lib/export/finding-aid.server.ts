/**
 * The finding aid — the one artifact that leaves the workspace
 *
 * This module deals with rendering a resolved export scope as a
 * print-optimised HTML finding aid: a title-and-identity page, the
 * named descriptive elements, and a container list. Ruling 3 of the
 * self-service export design settles the technology — Workers have no
 * headless browser, so v1 is HTML the reader's browser prints, not a
 * generated PDF binary. The artifact is stored RENDERED, so opening it
 * again a month later shows the catalogue as it stood on the day the
 * run took its snapshot.
 *
 * IT OBEYS PRINT, NOT THE INTERFACE. No dye is load-bearing anywhere in
 * the document: hierarchy is carried by indentation and hairline rules,
 * because a reading room will photocopy this in black and white and the
 * depth of a sub-unit must survive that. The type is a reading type at
 * reading sizes — serif body, sans for furniture only, mono for codes
 * and dates — which is the opposite proportion to the interface's, and
 * deliberately so.
 *
 * INTERNAL FIELDS ARE EXCLUDED UNCONDITIONALLY, whoever exports. Ruling
 * 2 (as re-ruled 2026-08-15) puts the finding aid in every member's
 * hands precisely because it is a quasi-publication genre, so the
 * renderer must not be able to leak an internal field even to an admin.
 * Two guards, not one: the element list is an ALLOWLIST derived from the
 * tenant's own standard profile, and `NEVER_RENDERED` is a denylist
 * subtracted from it afterwards, so adding a column to a standard
 * profile can never quietly publish it.
 *
 * The columns this document NEVER renders, and why:
 *
 *   - `internalNotes` — the schema's own words (migration 0059): it
 *     "never leaves the admin surface". The publish pipeline's
 *     description formatter excludes it by name for the same reason.
 *   - `createdBy`, `updatedBy`, `createdAt`, `updatedAt` — audit
 *     bookkeeping, excluded by the publish formatter by name.
 *   - `isPublished`, `lastExportedAt` — workflow bookkeeping; a reader
 *     has no business knowing when a record was last pushed to a site.
 *   - `legacyIds` — system-managed import provenance (the standard
 *     profiles render it read-only and never submit it); it names other
 *     systems' identifiers, not this repository's holdings.
 *   - `tenantId`, `id`, `parentId`, `rootDescriptionId`, `repositoryId`,
 *     `position`, `depth`, `childCount`, `pathCache` — internal
 *     identifiers and denormalised structure. The hierarchy they encode
 *     IS rendered, as indentation; the ids themselves are not.
 *
 * A second, separate list (`NOT_AN_ELEMENT`) holds columns that are
 * public but are not descriptive elements — `ocrText` (a machine
 * transcript, published to the public site but not a finding-aid
 * element), `hasDigital` and `iiifManifestUrl` (surrogate plumbing).
 * Keeping the two lists apart matters: one is a confidentiality rule
 * and the other is an editorial one, and conflating them would let a
 * future editorial decision quietly weaken the confidentiality rule.
 *
 * THE ELEMENT NAMES ARE THE WORKSPACE'S OWN. Nothing here invents a
 * label. The set of elements, their order and their grouping come from
 * the tenant's `StandardConfig` (`app/lib/standards/`), and the names
 * come from the `descriptions` locale bundle including its per-standard
 * overrides — so a DACS workspace reads "Biographical/Historical Note"
 * and a RAD workspace reads "Title proper", exactly as its own editor
 * does. The consequence is honest and worth stating: the RAD profile
 * declares no conditions-of-access element, so a RAD finding aid does
 * not carry one. That is the profile's statement about RAD, not this
 * renderer's opinion.
 *
 * SHORT VALUES GO IN THE LEDGER, NARRATIVE GOES UNDER A HEADING. The
 * split is mechanical rather than hand-listed: a profile field whose
 * primitive is `textarea` becomes a named element with its own
 * rule-under heading; a `text` field becomes a row in the identity
 * ledger. For DACS this reproduces the design card's page 2 exactly —
 * scope and content, biographical note, arrangement, custodial history,
 * and the two conditions — without a second list to keep in step.
 *
 * EMPTY ELEMENTS ARE OMITTED, at both scales. A heading over nothing
 * reads as a note that went missing in the export, so an element with
 * no text is not rendered; and a root whose every element is empty
 * contributes no section at all, which is what keeps a hand-picked list
 * of bare items a list rather than a hundred empty headings.
 *
 * THE COLOPHON IS MANDATORY, so a run that cannot name itself fails
 * rather than producing an unsigned document. `runId` is threaded into
 * the emit input by the run lifecycle; when it is absent the emitter
 * throws `finding-aid-run-id-unavailable` and the history row says so,
 * on the same principle `ExportFormatNotBuiltError` follows — a named,
 * actionable failure beats a plausible-looking file.
 *
 * FONTS ARE THE APP'S OWN, FETCHED THE WAY THE APP FETCHES THEM. Fisqua
 * does not self-host: `app/app.css` and `app/root.tsx` both pull
 * Spectral, Bricolage Grotesque and JetBrains Mono from the same Google
 * Fonts stylesheet URL, and this document reuses that exact URL rather
 * than adding a font pipeline. Every family therefore carries a print
 * fallback stack (Georgia, system sans, system mono) so a reader with
 * no network still gets a correctly proportioned page in a serif.
 *
 * RUNNING HEAD AND FOLIO SIT IN THE PAGE MARGIN via `@page` margin
 * boxes, which is the only mechanism that repeats them on every sheet
 * without a pagination engine. Chrome ignores margin boxes and prints
 * its own header and footer instead, so a Chrome reader gets a folio
 * from the browser rather than from the document; the on-screen sheet
 * draws its own head and folio so the artifact still reads as a page.
 * A `position: fixed` fallback was considered and rejected: it repeats
 * in Chrome but not in Firefox, which would double the running head on
 * the first sheet everywhere that margin boxes do work.
 *
 * @version v0.7.0
 */

import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { descriptions, repositories } from "../../db/schema";
import { getStandardConfig } from "../standards/registry";
import type { Standard } from "../standards/types";
import type { Tenant } from "../../context";
import enDescriptions from "../../locales/en/descriptions";
import esDescriptions from "../../locales/es/descriptions";
import { ID_CHUNK } from "./scopes.server";
import type { ExportScopeDescriptor } from "./scopes.server";
import { isDescriptiveStandardForm } from "./matrix";
import type { ExportArtifact, ExportEmitContext } from "./canonical-csv.server";
import type { ExportEmitInput, ExportEmitter } from "./emitters.server";

// ---------------------------------------------------------------------------
// What never reaches the page
// ---------------------------------------------------------------------------

/**
 * Description columns the finding aid NEVER renders, whoever exports.
 * Ruling 2's confidentiality rule; see the module header for the
 * reasoning behind each entry. Subtracted from the element list after
 * it is derived, so a column added to a standard profile cannot slip
 * onto the page.
 */
export const NEVER_RENDERED: ReadonlySet<string> = new Set([
  "internalNotes",
  "createdBy",
  "updatedBy",
  "createdAt",
  "updatedAt",
  "isPublished",
  "lastExportedAt",
  "legacyIds",
  "tenantId",
  "id",
  "parentId",
  "rootDescriptionId",
  "repositoryId",
  "position",
  "depth",
  "childCount",
  "pathCache",
]);

/**
 * Public columns that are not descriptive elements. An editorial rule,
 * kept apart from the confidentiality rule above on purpose.
 */
const NOT_AN_ELEMENT: ReadonlySet<string> = new Set([
  "ocrText",
  "hasDigital",
  "iiifManifestUrl",
  // Linker pseudo-columns the profiles declare for the form renderer;
  // no such column exists on `descriptions`.
  "entities",
  "places",
]);

/**
 * The identity ledger, in the order the design card states it. These
 * columns are shown at the head of the document and are therefore not
 * repeated among the elements. `repositoryId` is the ledger's one
 * resolved value — the row holds an id and the page prints a name.
 */
const IDENTITY_LEDGER: readonly string[] = [
  "referenceCode",
  "title",
  "dateExpression",
  "extent",
  "creatorDisplay",
  "language",
  "repositoryId",
];

/**
 * Columns the identity ledger already accounts for, so the profile walk
 * does not print them a second time. `dateStart` and `dateEnd` are the
 * machine halves of the Dates row; a document that printed all three
 * would be repeating itself in a smaller type.
 */
const LEDGER_COVERED: ReadonlySet<string> = new Set([
  ...IDENTITY_LEDGER,
  "dateStart",
  "dateEnd",
]);

/** Profile primitives that carry rendered narrative or short values. */
const NARRATIVE_PRIMITIVE = "textarea";
const LEDGER_PRIMITIVES: ReadonlySet<string> = new Set(["text", "date"]);

/**
 * Elements that lead, whatever order the profile declares them in. A
 * finding aid opens with what the material IS; the DACS profile happens
 * to reach its context section before its content section, which is the
 * right order for a form and the wrong one for a document. Everything
 * else follows in the profile's own order.
 */
const ELEMENT_LEAD: readonly string[] = ["scopeContent"];

/**
 * A scope note shorter than the floor is its own abstract, so no
 * abstract is printed; a longer one is cut to the cap. Both are
 * measured in characters of flattened prose — roughly a short and a
 * long paragraph at the document's measure.
 */
const ABSTRACT_FLOOR = 700;
const ABSTRACT_CAP = 620;

// ---------------------------------------------------------------------------
// Document language
// ---------------------------------------------------------------------------

/** The two languages the document furniture is written in. */
export type FindingAidLocale = "en" | "es";

/**
 * Furniture the document needs that no description field names. Field
 * and level labels are NOT here — those come from the `descriptions`
 * locale bundle, so the document and the editor call things the same
 * thing. The register is formal written Spanish: this is a document a
 * repository hands to a reader, not an interface addressing them.
 */
const DOC_STRINGS: Record<FindingAidLocale, Record<string, string>> = {
  en: {
    documentKind: "Descriptive inventory",
    abstract: "Abstract",
    containerList: "Container list",
    units: "units",
    unit: "unit",
    describedUnits: "described units",
    scopeOfExport: "Scope of this export",
    recordsInExport: "Records in this export",
    searchTerms: "Search",
    found: "found",
    unticked: "unticked",
    scopeWorkspace: "Whole workspace",
    scopeCarried: "Records carried from a search",
    scopeHandlist: "Handlist",
    preparedWith: "Prepared with Fisqua",
    preparedFor: "for",
    describedTo: "described to",
    generated: "generated",
    scopeLabel: "scope",
    exportLabel: "export",
    snapshot:
      "This finding aid describes the holdings as recorded on the date above. The catalogue continues to change; later descriptions will not appear here.",
  },
  es: {
    documentKind: "Inventario descriptivo",
    abstract: "Resumen",
    containerList: "Relación de unidades",
    units: "unidades",
    unit: "unidad",
    describedUnits: "unidades descritas",
    scopeOfExport: "Alcance de la exportación",
    recordsInExport: "Registros en esta exportación",
    searchTerms: "Búsqueda",
    found: "encontrados",
    unticked: "sin marcar",
    scopeWorkspace: "Todo el espacio de trabajo",
    scopeCarried: "Registros traídos de una búsqueda",
    scopeHandlist: "Lista de trabajo",
    preparedWith: "Preparado con Fisqua",
    preparedFor: "para",
    describedTo: "descrito según",
    generated: "generado",
    scopeLabel: "alcance",
    exportLabel: "exportación",
    snapshot:
      "Este instrumento de consulta describe las colecciones tal como estaban registradas en la fecha indicada. El catálogo sigue cambiando; las descripciones posteriores no aparecerán aquí.",
  },
};

/**
 * The standards' own names, as the landing page already writes them
 * (`app/locales/{en,es}/landing.ts`). Not an expansion of an acronym —
 * these are the names the standards are published under.
 */
const STANDARD_NAMES: Record<Standard, string> = {
  isadg: "ISAD(G)",
  dacs: "DACS",
  rad: "RAD",
};

/**
 * The two bundles, widened to a plain string map. The literal types
 * TypeScript infers from each bundle are per-language ("Descriptions"
 * vs "Descripciones"), so the pair only shares a type once the values
 * are read as strings — which is all a label lookup wants.
 */
type LabelBundle = { fields: Record<string, string> } & Record<string, unknown>;

const LOCALE_BUNDLES: Record<FindingAidLocale, LabelBundle> = {
  en: enDescriptions as unknown as LabelBundle,
  es: esDescriptions as unknown as LabelBundle,
};

/** BCP-47 tags for number and date formatting inside the document. */
const INTL_LOCALES: Record<FindingAidLocale, string> = {
  en: "en-US",
  es: "es-CO",
};

/**
 * A field's name in this workspace's own vocabulary: the per-standard
 * override first (`fields["title.rad"]`), then the shared label, then
 * the column name itself, which only surfaces if a profile ever names a
 * column the locale bundle has not caught up with.
 */
function fieldLabel(
  column: string,
  standard: Standard,
  locale: FindingAidLocale,
): string {
  const fields = LOCALE_BUNDLES[locale].fields;
  return fields[`${column}.${standard}`] ?? fields[column] ?? column;
}

/** A description level's name, from the same bundle the editor reads. */
function levelLabel(level: string, locale: FindingAidLocale): string {
  const value = LOCALE_BUNDLES[locale][`level_${level}`];
  return typeof value === "string" ? value : level;
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/**
 * A finding aid that cannot be signed. Carries `code` and `detail`
 * directly rather than extending `ExportRunFailure`, which would make
 * this module import the lifecycle that imports the emitter registry
 * that imports this module. The lifecycle's `toFailure` reads those two
 * properties off any thrown object, so the recorded failure is
 * identical either way.
 */
export class FindingAidError extends Error {
  readonly code: string;
  readonly detail?: Record<string, unknown>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "FindingAidError";
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// The emitter
// ---------------------------------------------------------------------------

/**
 * What the finding aid needs beyond the shared emit input. `runId` is
 * the colophon's run number and is required in practice; it is optional
 * on the type only because the shared `ExportEmitInput` does not carry
 * it yet, and a missing one is a named failure rather than a compile
 * error the other clusters would have to absorb.
 */
export interface FindingAidEmitInput extends ExportEmitInput {
  runId?: string;
  /** Injectable clock, so a test can pin the snapshot line. */
  now?: () => number;
  /**
   * The document's language. No tenant-level locale column exists, so
   * this defaults to the app's own fallback language (`es`, per
   * `app/middleware/i18next.ts`) until a caller states otherwise.
   */
  locale?: FindingAidLocale;
}

/**
 * The registry entry. Signature is `ExportEmitter` exactly; the extra
 * fields are read off the input when the lifecycle supplies them.
 */
export const pdfEmitter: ExportEmitter = async (input, ctx) => {
  return renderFindingAid(input as FindingAidEmitInput, ctx);
};

/**
 * Render a scope as a finding aid.
 *
 * The legality matrix has already refused everything this renderer
 * cannot draw — an authority scope, or a form that is not a descriptive
 * standard — so the two assertions here are guards against a caller
 * that bypassed it, not branches with a design behind them.
 */
export async function renderFindingAid(
  input: FindingAidEmitInput,
  ctx: ExportEmitContext,
): Promise<ExportArtifact> {
  const { db, tenant, scope, form } = input;

  if (!isDescriptiveStandardForm(form)) {
    throw new FindingAidError(
      "pdf-needs-descriptive-standard",
      "A finding aid renders a descriptive standard",
      { form },
    );
  }
  if (scope.recordClass !== "records") {
    throw new FindingAidError(
      "pdf-needs-descriptive-standard",
      "A finding aid renders archival descriptions, not authority records",
      { recordClass: scope.recordClass },
    );
  }
  const runId = input.runId;
  if (!runId) {
    throw new FindingAidError(
      "finding-aid-run-id-unavailable",
      "A finding aid must name the run that produced it",
    );
  }

  const standard: Standard = form;
  const locale: FindingAidLocale = input.locale ?? "es";
  const now = (input.now ?? (() => Date.now()))();

  // ---- Stage 1: the descriptions --------------------------------------
  const total = scope.memberIds.length;
  await ctx.checkpoint("descriptions", 0, total);
  const rows = new Map<string, DescriptionRow>();
  let done = 0;
  for (const part of chunk(scope.memberIds)) {
    for (const row of await readDescriptions(db, tenant, part)) rows.set(row.id, row);
    done += part.length;
    await ctx.checkpoint("descriptions", Math.min(done, total), total);
  }
  const ordered = scope.memberIds
    .map((id) => rows.get(id))
    .filter((row): row is DescriptionRow => row !== undefined);
  if (ordered.length === 0) {
    throw new FindingAidError(
      "scope-empty",
      "Nothing in this scope survived to the artifact",
    );
  }

  const repos = await readRepositories(
    db,
    tenant,
    [...new Set(ordered.map((row) => row.repositoryId))],
  );

  // The finding aid carries no authority index: the design card draws
  // three pages and none of them is one, so the authorities toggle has
  // nothing to add or withhold here. The stage is skipped rather than
  // reported as zero work, because a working line that claims a stage
  // it did not run is worse than one stage shorter.

  // ---- Stage 2: the document -------------------------------------------
  await ctx.checkpoint("serializing", 0, 1);
  const body = buildDocument({
    tenant,
    standard,
    locale,
    now,
    runId,
    descriptor: scope.descriptor,
    rows: ordered,
    repos,
  });
  await ctx.checkpoint("serializing", 1, 1);

  return {
    body,
    contentType: "text/html; charset=utf-8",
    extension: "html",
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type DescriptionRow = typeof descriptions.$inferSelect;
type RepositoryRow = typeof repositories.$inferSelect;

function chunk<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function readDescriptions(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  ids: string[],
): Promise<DescriptionRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(descriptions)
    .where(and(eq(descriptions.tenantId, tenant.id), inArray(descriptions.id, ids)))
    .all();
}

async function readRepositories(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  ids: string[],
): Promise<Map<string, RepositoryRow>> {
  const out = new Map<string, RepositoryRow>();
  for (const part of chunk(ids)) {
    const found = await db
      .select()
      .from(repositories)
      .where(
        and(eq(repositories.tenantId, tenant.id), inArray(repositories.id, part)),
      )
      .all();
    for (const row of found) out.set(row.id, row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The element list, derived from the workspace's own standard
// ---------------------------------------------------------------------------

interface ProfileField {
  column: string;
  label: string;
}

interface ProfileSplit {
  /** Short values, printed as ledger rows in profile order. */
  ledger: ProfileField[];
  /** Narrative elements, each with its own rule-under heading. */
  elements: ProfileField[];
}

/**
 * The tenant's standard, split into the two shapes the document draws.
 * Deduplicated by column and first-occurrence-wins, because a profile
 * may legitimately name one column twice — DACS declares
 * `accessConditions` under both Conditions of Access and its Rights
 * Statements pseudo-section, and a finding aid must print it once.
 */
function profileSplit(standard: Standard, locale: FindingAidLocale): ProfileSplit {
  const config = getStandardConfig(standard);
  const ledger: ProfileField[] = [];
  const elements: ProfileField[] = [];
  const seen = new Set<string>(LEDGER_COVERED);

  for (const section of config.sections) {
    for (const field of section.fields) {
      const column = field.column;
      if (seen.has(column)) continue;
      if (NEVER_RENDERED.has(column) || NOT_AN_ELEMENT.has(column)) continue;
      const entry = { column, label: fieldLabel(column, standard, locale) };
      if (field.primitive === NARRATIVE_PRIMITIVE) {
        elements.push(entry);
        seen.add(column);
      } else if (LEDGER_PRIMITIVES.has(field.primitive)) {
        ledger.push(entry);
        seen.add(column);
      }
      // Every other primitive is a control rather than a value —
      // selects, linkers, checkboxes, the legacy-ids widget — and has
      // no place in a printed document.
    }
  }

  // The denylist is applied twice on purpose: once above while walking
  // the profile, and once here over the finished lists. The second pass
  // is the one that survives a refactor of the first.
  const ordered = [
    ...ELEMENT_LEAD.flatMap((column) =>
      elements.filter((field) => field.column === column),
    ),
    ...elements.filter((field) => !ELEMENT_LEAD.includes(field.column)),
  ];

  return {
    ledger: ledger.filter((f) => !NEVER_RENDERED.has(f.column)),
    elements: ordered.filter((f) => !NEVER_RENDERED.has(f.column)),
  };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A string safe to sit inside a CSS `content: "..."` declaration. */
function cssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function has(value: unknown): boolean {
  return text(value) !== "";
}

/**
 * A code-shaped token, for the mono treatment reference codes get when
 * they appear inside prose. The regex only proposes candidates; a
 * candidate is marked only when it is a reference code that is actually
 * in this export, so an access condition that cites CMD-SR-0204 becomes
 * findable in the container list and an ordinary hyphenated word does
 * not become a false lead.
 */
const CODE_CANDIDATE = /\b[A-Za-z][A-Za-z0-9]*(?:[-/.][A-Za-z0-9]+)+\b/g;

function markCodes(escaped: string, codes: ReadonlySet<string>): string {
  if (codes.size === 0) return escaped;
  return escaped.replace(CODE_CANDIDATE, (token) =>
    codes.has(token) ? `<span class="c">${token}</span>` : token,
  );
}

/**
 * Prose as paragraphs. Blank lines separate paragraphs; single newlines
 * inside a paragraph are the cataloguer's wrapping, not their intent,
 * and are collapsed.
 */
function paragraphs(value: string): string[] {
  return value
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s*\n\s*/g, " ").trim())
    .filter((part) => part !== "");
}

function renderProse(
  value: string,
  codes: ReadonlySet<string>,
  firstLineSmallCaps = false,
): string {
  return paragraphs(value)
    .map((part, index) => {
      const classes = index === 0 && firstLineSmallCaps ? "b first" : "b";
      return `<p class="${classes}">${markCodes(escapeHtml(part), codes)}</p>`;
    })
    .join("");
}

/** A four-digit year off an ISO-ish date column, when there is one. */
function year(value: unknown): number | null {
  const match = /(\d{4})/.exec(text(value));
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** The span a set of rows covers, as the document prints it. */
function yearSpan(rows: readonly DescriptionRow[]): string {
  let low: number | null = null;
  let high: number | null = null;
  for (const row of rows) {
    for (const candidate of [year(row.dateStart), year(row.dateEnd)]) {
      if (candidate === null) continue;
      if (low === null || candidate < low) low = candidate;
      if (high === null || candidate > high) high = candidate;
    }
  }
  if (low === null || high === null) return "";
  return low === high ? String(low) : `${low}–${high}`;
}

/** One row's dates: what the cataloguer wrote, or the span they implied. */
function rowDates(row: DescriptionRow): string {
  if (has(row.dateExpression)) return text(row.dateExpression);
  return yearSpan([row]);
}

function formatCount(n: number, locale: FindingAidLocale): string {
  return new Intl.NumberFormat(INTL_LOCALES[locale]).format(n);
}

/**
 * The snapshot stamp: minute precision, UTC, stated as UTC. A finding
 * aid that dates itself in an unnamed timezone is a finding aid whose
 * date cannot be checked against anything.
 */
function stamp(now: number): string {
  return `${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A one-line scope note for a series heading. */
function shortNote(value: string, limit = 180): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 60 ? cut.slice(0, boundary) : cut).replace(/[.,;:]$/, "")}…`;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

interface DocumentInput {
  tenant: Tenant;
  standard: Standard;
  locale: FindingAidLocale;
  now: number;
  runId: string;
  descriptor: ExportScopeDescriptor;
  /** The scope's members, in the scope's own order. */
  rows: DescriptionRow[];
  repos: Map<string, RepositoryRow>;
}

/** The hierarchy of the exported set, as far as the set itself shows it. */
interface Tree {
  byId: Map<string, DescriptionRow>;
  childrenOf: Map<string, DescriptionRow[]>;
  roots: DescriptionRow[];
}

function buildTree(rows: DescriptionRow[]): Tree {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const childrenOf = new Map<string, DescriptionRow[]>();
  const roots: DescriptionRow[] = [];
  for (const row of rows) {
    const parent = row.parentId;
    if (parent !== null && byId.has(parent)) {
      const list = childrenOf.get(parent) ?? [];
      list.push(row);
      childrenOf.set(parent, list);
    } else {
      roots.push(row);
    }
  }
  return { byId, childrenOf, roots };
}

/** Everything under a node that is also in the export, in preorder. */
function descendants(tree: Tree, row: DescriptionRow): DescriptionRow[] {
  const out: DescriptionRow[] = [];
  const walk = (node: DescriptionRow): void => {
    for (const child of tree.childrenOf.get(node.id) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(row);
  return out;
}

/** Depth of a node relative to a given ancestor, within the export. */
function relativeDepth(tree: Tree, row: DescriptionRow, rootId: string): number {
  let depth = 0;
  let cursor: DescriptionRow | undefined = row;
  while (cursor && cursor.id !== rootId) {
    const parentId: string | null = cursor.parentId;
    if (parentId === null) break;
    cursor = tree.byId.get(parentId);
    depth += 1;
    if (depth > 32) break;
  }
  return depth;
}

function buildDocument(input: DocumentInput): string {
  const { tenant, standard, locale, rows, repos, descriptor } = input;
  const strings = DOC_STRINGS[locale];
  const split = profileSplit(standard, locale);
  const tree = buildTree(rows);
  const codes = new Set(rows.map((row) => row.referenceCode).filter((c) => c !== ""));

  const single = tree.roots.length === 1 ? tree.roots[0] : null;
  const repoOf = (row: DescriptionRow): RepositoryRow | undefined =>
    repos.get(row.repositoryId);

  // The running head names the repository on the left and the described
  // whole on the right. A multi-root export has no single described
  // whole, so the scope stands in its place.
  const headRepository = single
    ? (repoOf(single)?.name ?? tenant.name)
    : uniqueRepositoryNames(rows, repos).slice(0, 1)[0] ?? tenant.name;
  const headSubject = single
    ? [single.title, single.referenceCode].filter((s) => s !== "").join(" · ")
    : scopeLabel(descriptor, strings);

  const sections: string[] = [];

  // ---- The title and identity page -------------------------------------
  sections.push(
    identityPage({
      ...input,
      strings,
      split,
      tree,
      codes,
      single,
      headRepository,
      headSubject,
    }),
  );

  // ---- The descriptive elements ----------------------------------------
  if (single) {
    const elements = elementBlocks(single, split.elements, codes);
    if (elements !== "") {
      sections.push(
        sheet(
          headRepository,
          headSubject,
          `<div class="doc">${elements}</div>`,
        ),
      );
    }
  } else {
    // One section per root: the identity page described the scope, so
    // each root has to introduce itself before its own elements.
    for (const root of tree.roots) {
      const elements = elementBlocks(root, split.elements, codes);
      if (elements === "") continue;
      sections.push(
        sheet(
          headRepository,
          headSubject,
          `<div class="doc">${rootHeading(root, locale)}${elements}</div>`,
        ),
      );
    }
  }

  // ---- The container list ----------------------------------------------
  const list = containerList({ tree, single, strings, locale, codes });
  if (list !== "") {
    sections.push(
      sheet(
        headRepository,
        headSubject,
        `<div class="doc"><h3 class="cl-head">${escapeHtml(strings.containerList)}</h3><div class="cl">${list}</div></div>`,
      ),
    );
  }

  const title = single
    ? single.title
    : `${scopeLabel(descriptor, strings)} — ${tenant.name}`;

  return page({
    locale,
    title,
    headRepository,
    headSubject,
    sections,
  });
}

function uniqueRepositoryNames(
  rows: readonly DescriptionRow[],
  repos: Map<string, RepositoryRow>,
): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const repo = repos.get(row.repositoryId);
    if (repo) names.add(repo.name);
  }
  return [...names];
}

/** The scope in the ledger's own words, for a multi-root document. */
function scopeLabel(
  descriptor: ExportScopeDescriptor,
  strings: Record<string, string>,
): string {
  switch (descriptor.kind) {
    case "workspace":
      return strings.scopeWorkspace;
    case "branch":
      return descriptor.title || descriptor.referenceCode;
    case "carried":
      return descriptor.pills.length > 0
        ? descriptor.pills.join(" · ")
        : strings.scopeCarried;
    case "handlist":
      return descriptor.name;
  }
}

// ---------------------------------------------------------------------------
// Page 1 — title, identity, abstract, colophon
// ---------------------------------------------------------------------------

interface IdentityInput extends DocumentInput {
  strings: Record<string, string>;
  split: ProfileSplit;
  tree: Tree;
  codes: ReadonlySet<string>;
  single: DescriptionRow | null;
  headRepository: string;
  headSubject: string;
}

function identityPage(input: IdentityInput): string {
  const { strings, single, rows, repos, tree, descriptor } = input;

  const span = single
    ? rowDates(single) || yearSpan(descendants(tree, single).concat(single))
    : yearSpan(rows);

  const repository = single ? repos.get(single.repositoryId) : undefined;
  const overline = single
    ? (repository?.name ?? input.tenant.name)
    : input.tenant.name;
  const heading = single ? single.title : scopeLabel(descriptor, strings);
  const subtitle = [strings.documentKind, span].filter((s) => s !== "").join(" · ");

  const ledger = single
    ? singleRootLedger(input, single)
    : scopeLedger(input);

  // The abstract is a précis of the scope note — which is what a finding
  // aid's abstract is — and it earns its place only when it is genuinely
  // shorter than the element it precedes. A scope note that already fits
  // in an abstract gets no abstract, because the reader would otherwise
  // meet the same paragraph twice within one page turn. Same rule as
  // omitting an empty element, applied to a redundant one.
  let abstract = "";
  if (single && has(single.scopeContent)) {
    const flat = paragraphs(text(single.scopeContent)).join(" ");
    if (flat.length > ABSTRACT_FLOOR) {
      abstract =
        `<h3>${escapeHtml(strings.abstract)}</h3>` +
        `<p class="b">${markCodes(escapeHtml(shortNote(flat, ABSTRACT_CAP)), input.codes)}</p>`;
    }
  }

  const colophon = renderColophon(input);

  const body =
    `<div class="doc">` +
    `<p class="rep">${escapeHtml(overline)}</p>` +
    `<h2>${escapeHtml(heading)}</h2>` +
    (subtitle === "" ? "" : `<p class="sub">${escapeHtml(subtitle)}</p>`) +
    `<hr class="rule">` +
    ledger +
    abstract +
    `</div>` +
    colophon;

  return sheet(input.headRepository, input.headSubject, body);
}

/** The identity ledger of one described whole. */
function singleRootLedger(input: IdentityInput, root: DescriptionRow): string {
  const { standard, locale, split, repos, tree } = input;
  const strings = input.strings;
  const rowsOut: [string, string, boolean][] = [];

  const push = (column: string, value: string, mono = false): void => {
    if (value.trim() === "") return;
    rowsOut.push([fieldLabel(column, standard, locale), value, mono]);
  };

  push("referenceCode", text(root.referenceCode), true);
  push("title", text(root.title));
  push("dateExpression", rowDates(root), true);

  const unitCount = descendants(tree, root).length;
  const extent = [
    text(root.extent),
    unitCount > 0
      ? `${formatCount(unitCount, locale)} ${strings.describedUnits}`
      : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
  push("extent", extent);

  push("creatorDisplay", text(root.creatorDisplay));
  push("language", text(root.language));

  const repo = repos.get(root.repositoryId);
  if (repo) {
    push(
      "repositoryId",
      [repo.name, text(repo.city)].filter((part) => part !== "").join(", "),
    );
  }

  // Everything else the profile calls a short value, in profile order.
  for (const field of split.ledger) {
    const value = text((root as unknown as Record<string, unknown>)[field.column]);
    if (value === "") continue;
    rowsOut.push([field.label, value, false]);
  }

  return ledgerHtml(rowsOut);
}

/** The identity ledger of a scope that spans more than one whole. */
function scopeLedger(input: IdentityInput): string {
  const { strings, locale, rows, repos, descriptor, tree } = input;
  const rowsOut: [string, string, boolean][] = [];

  rowsOut.push([strings.scopeOfExport, scopeLabel(descriptor, strings), false]);
  if (descriptor.kind === "carried" && descriptor.pills.length > 0) {
    rowsOut.push([strings.searchTerms, descriptor.pills.join(" · "), false]);
  }
  // A carried scope states its own arithmetic, because the document has
  // to be able to answer "why 1,198 and not 1,204?" a year later, when
  // the search that produced it is long gone.
  const arithmetic =
    descriptor.kind === "carried"
      ? ` · ${formatCount(descriptor.found, locale)} ${strings.found}, ${formatCount(
          descriptor.unticked,
          locale,
        )} ${strings.unticked}`
      : "";
  rowsOut.push([
    strings.recordsInExport,
    `${formatCount(rows.length, locale)}${arithmetic}`,
    false,
  ]);

  const span = yearSpan(rows);
  if (span !== "") {
    rowsOut.push([fieldLabel("dateExpression", input.standard, locale), span, true]);
  }

  const names = uniqueRepositoryNames(rows, repos);
  if (names.length > 0) {
    rowsOut.push([
      fieldLabel("repositoryId", input.standard, locale),
      names.slice(0, 4).join(" · ") + (names.length > 4 ? " …" : ""),
      false,
    ]);
  }

  return ledgerHtml(rowsOut);
}

function ledgerHtml(entries: [string, string, boolean][]): string {
  if (entries.length === 0) return "";
  const body = entries
    .map(
      ([label, value, mono]) =>
        `<dt>${escapeHtml(label)}</dt><dd${mono ? ' class="mono"' : ""}>${escapeHtml(value)}</dd>`,
    )
    .join("");
  return `<dl>${body}</dl>`;
}

/**
 * The colophon. Mandatory, and the reason the run number is required:
 * a finding aid without a date and a run is a finding aid nobody can
 * trust twice.
 */
function renderColophon(input: IdentityInput): string {
  const { strings, tenant, standard, locale, now, runId, rows, descriptor } = input;
  const line1 =
    `<b>${escapeHtml(strings.preparedWith)}</b> ${escapeHtml(strings.preparedFor)} ` +
    `${escapeHtml(tenant.name)} · ${escapeHtml(strings.describedTo)} ` +
    `${escapeHtml(STANDARD_NAMES[standard])}`;
  const line2 = [
    `${strings.generated} ${stamp(now)}`,
    `${strings.scopeLabel}: ${scopeLabel(descriptor, strings)}`,
    `${formatCount(rows.length, locale)} ${rows.length === 1 ? strings.unit : strings.units}`,
    `${strings.exportLabel} ${runId}`,
  ]
    .map(escapeHtml)
    .join(" · ");

  return (
    `<div class="colo">` +
    `<p>${line1}</p>` +
    `<p class="m">${line2}</p>` +
    `<p class="snap">${escapeHtml(strings.snapshot)}</p>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Page 2 — the named descriptive elements
// ---------------------------------------------------------------------------

/**
 * One heading per element, each with a rule beneath, in the order the
 * workspace's own standard names them. An element with no text is not
 * rendered at all.
 */
function elementBlocks(
  row: DescriptionRow,
  elements: readonly ProfileField[],
  codes: ReadonlySet<string>,
): string {
  const blocks: string[] = [];
  let first = true;
  for (const field of elements) {
    const value = text((row as unknown as Record<string, unknown>)[field.column]);
    if (value === "") continue;
    blocks.push(
      `<h3>${escapeHtml(field.label)}</h3>${renderProse(value, codes, first)}`,
    );
    first = false;
  }
  return blocks.join("");
}

/** A root introducing itself, when the document describes several. */
function rootHeading(row: DescriptionRow, locale: FindingAidLocale): string {
  const dates = rowDates(row);
  const meta = [row.referenceCode, dates].filter((part) => part !== "").join(" · ");
  return (
    `<p class="rep">${escapeHtml(levelLabel(row.descriptionLevel, locale))}</p>` +
    `<h2 class="rooth">${escapeHtml(row.title)}</h2>` +
    (meta === "" ? "" : `<p class="rootm">${escapeHtml(meta)}</p>`) +
    `<hr class="rule">`
  );
}

// ---------------------------------------------------------------------------
// Page 3 — the container list
// ---------------------------------------------------------------------------

interface ContainerListInput {
  tree: Tree;
  single: DescriptionRow | null;
  strings: Record<string, string>;
  locale: FindingAidLocale;
  codes: ReadonlySet<string>;
}

/**
 * The arrangement made visible. Three levels and no more: a section
 * heading flush left, its units indented once, everything below them
 * indented twice. Depth beyond that is clamped rather than dropped —
 * the row still appears, at the deepest indent the page has.
 *
 * A node that heads nothing is not a section. That is what keeps a
 * hand-picked list of items a list of item rows rather than a run of
 * empty headings, and it falls out of the same rule that gives a fonds
 * its series.
 */
function containerList(input: ContainerListInput): string {
  const { tree, single } = input;
  const top = single ? (tree.childrenOf.get(single.id) ?? []) : tree.roots;
  // A single root with nothing under it: the identity page has already
  // said everything a list could.
  if (top.length === 0) return "";

  const out: string[] = [];
  let loose: string[] = [];
  const flushLoose = (): void => {
    if (loose.length === 0) return;
    out.push(`<div class="ser loose">${loose.join("")}</div>`);
    loose = [];
  };

  let index = 0;
  for (const node of top) {
    const kids = descendants(tree, node);
    if (kids.length === 0) {
      loose.push(unitRow(node, 1));
      continue;
    }
    flushLoose();
    index += 1;
    out.push(seriesSection(node, kids, index, input));
  }
  flushLoose();
  return out.join("");
}

function seriesSection(
  node: DescriptionRow,
  kids: DescriptionRow[],
  index: number,
  input: ContainerListInput,
): string {
  const { strings, locale, tree } = input;
  const dates = rowDates(node) || yearSpan([node, ...kids]);
  const meta = [node.referenceCode, dates].filter((p) => p !== "").join(" · ");
  const heading =
    `<b>${escapeHtml(`${levelLabel(node.descriptionLevel, locale)} ${index} · ${node.title}`)}` +
    (meta === "" ? "" : ` <em>${escapeHtml(meta)}</em>`) +
    `</b>`;

  const note = [
    has(node.scopeContent) ? shortNote(text(node.scopeContent)) : "",
    `${formatCount(kids.length, locale)} ${kids.length === 1 ? strings.unit : strings.units}.`,
  ]
    .filter((part) => part !== "")
    .join(" ");

  const rows = kids
    .map((kid) => unitRow(kid, Math.min(relativeDepth(tree, kid, node.id), 2)))
    .join("");

  return (
    `<div class="ser">` +
    `<div class="serh">${heading}<p class="sn">${escapeHtml(note)}</p></div>` +
    rows +
    `</div>`
  );
}

function unitRow(row: DescriptionRow, depth: number): string {
  const klass = depth >= 2 ? "it sub" : "it";
  const dates = rowDates(row);
  return (
    `<div class="${klass}">` +
    `<code>${escapeHtml(row.referenceCode)}</code>` +
    `<span>${escapeHtml(row.title)}</span>` +
    `<small>${escapeHtml(dates)}</small>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// The sheet and the stylesheet
// ---------------------------------------------------------------------------

/**
 * One sheet: the page furniture the card draws inside the paper, plus
 * whatever the caller put on it. On screen the head and the folio are
 * part of the sheet; in print they are hidden and the `@page` margin
 * boxes take over, so they never appear twice.
 */
function sheet(repository: string, subject: string, body: string): string {
  return (
    `<section class="sheet">` +
    `<div class="run"><span>${escapeHtml(repository)}</span><span>${escapeHtml(subject)}</span></div>` +
    body +
    `<div class="fol"><span>${escapeHtml(repository)}</span><span class="pn"></span></div>` +
    `</section>`
  );
}

interface PageInput {
  locale: FindingAidLocale;
  title: string;
  headRepository: string;
  headSubject: string;
  sections: string[];
}

function page(input: PageInput): string {
  const { locale, title, headRepository, headSubject, sections } = input;
  return (
    `<!doctype html>\n` +
    `<html lang="${locale}">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    `<style>\n${stylesheet(headRepository, headSubject)}\n</style>\n` +
    `</head>\n<body>\n<div class="scroller">\n${sections.join("\n")}\n</div>\n</body>\n</html>\n`
  );
}

/**
 * The whole document's CSS, inline. The font stylesheet is the one
 * `app/app.css` and `app/root.tsx` already load, so the artifact uses
 * the workspace's own type; every family falls back to a bundled face
 * so a reader with no network still gets a proportioned page.
 */
function stylesheet(headRepository: string, headSubject: string): string {
  return `@import url("https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700&family=JetBrains+Mono:wght@400;500&display=swap");

:root{
  --serif:"Spectral",ui-serif,Georgia,"Times New Roman",serif;
  --sans:"Bricolage Grotesque",ui-sans-serif,system-ui,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;
  --ink:#1a1a1a; --quiet:#555; --hair:#e2e2e2; --rule:#ccc;
  --side:0.72in; --head:0.64in; --foot:0.47in;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#e9e7e3;color:var(--ink)}

/* The artifact does not reflow (narrow contract 06): a Letter sheet
   reduced to 768 of anything is no longer the artifact, so it scrolls
   horizontally inside its own frame instead. */
.scroller{overflow-x:auto;padding:24px 16px;counter-reset:sheet}
.sheet{
  counter-increment:sheet;
  position:relative;width:8.5in;min-height:11in;margin:0 auto 24px;
  background:#fff;box-shadow:0 2px 14px rgba(0,0,0,0.14);
  padding:var(--head) var(--side) var(--foot);
  display:flex;flex-direction:column;
}
.sheet .run{
  position:absolute;top:calc(var(--head) - 0.26in);left:var(--side);right:var(--side);
  display:flex;justify-content:space-between;gap:16px;
  font-family:var(--sans);font-size:8px;letter-spacing:0.06em;text-transform:uppercase;
  color:#767676;border-bottom:0.5px solid #bdbdbd;padding-bottom:5px;
}
.sheet .fol{
  position:absolute;bottom:calc(var(--foot) - 0.2in);left:var(--side);right:var(--side);
  display:flex;justify-content:space-between;
  font-family:var(--sans);font-size:8px;color:#767676;
  font-variant-numeric:lining-nums tabular-nums;
}
/* On screen a sheet is a sheet, so it numbers itself. In print the
   @page box below owns the folio and this one is hidden with it. */
.sheet .fol .pn::before{content:counter(sheet)}

.doc{font-family:var(--serif);color:var(--ink)}
.doc .rep{font-family:var(--sans);font-size:9.5px;letter-spacing:0.1em;text-transform:uppercase;color:#555;margin:0}
.doc h2{font-size:23px;line-height:1.22;font-weight:600;margin:16px 0 0;letter-spacing:-0.01em}
.doc h2.rooth{margin-top:6px;font-size:19px}
.doc .sub{font-size:14px;line-height:1.4;font-style:italic;color:#444;margin:7px 0 0}
.doc .rootm{font-family:var(--mono);font-size:10px;color:#555;margin:6px 0 0;font-variant-numeric:lining-nums tabular-nums}
.doc .rule{border:0;border-top:1px solid var(--rule);margin:20px 0 0}

.doc dl{margin:18px 0 0;display:grid;grid-template-columns:1.35in 1fr;gap:7px 14px}
.doc dt{font-family:var(--sans);font-size:8.5px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#666;padding-top:2px}
.doc dd{margin:0;font-size:12px;line-height:1.45}
.doc dd.mono{font-family:var(--mono);font-size:11px;font-variant-numeric:lining-nums tabular-nums}

.doc h3{
  font-family:var(--serif);font-size:13px;font-weight:600;letter-spacing:0.02em;
  margin:19px 0 0;padding-bottom:3px;border-bottom:0.5px solid var(--rule);
  break-after:avoid;page-break-after:avoid;
}
.doc h3.cl-head{margin-bottom:12px}
.doc p.b{font-size:12px;line-height:1.62;margin:8px 0 0;text-align:justify;hyphens:auto;orphans:2;widows:2}
.doc p.b.first::first-line{font-variant:small-caps}
.doc .c{font-family:var(--mono);font-size:0.92em;font-variant-numeric:lining-nums tabular-nums}

/* The colophon: the snapshot claim, in the document itself. */
.colo{margin-top:auto;padding-top:10px;border-top:0.5px solid var(--rule);break-inside:avoid;page-break-inside:avoid}
.colo p{font-family:var(--sans);font-size:8.5px;line-height:1.5;color:#666;margin:0}
.colo p b{font-weight:600;color:#333}
.colo p.m{font-family:var(--mono);font-size:8px;color:#777;margin-top:3px;font-variant-numeric:lining-nums tabular-nums;word-break:break-all}
.colo p.snap{margin-top:4px}

/* Container list: depth by indentation and hairlines, never by fill. */
.cl{margin:0}
.cl .ser{margin:15px 0 0}
.cl .ser:first-child{margin-top:0}
.cl .serh{break-inside:avoid;page-break-inside:avoid;break-after:avoid;page-break-after:avoid}
.cl .ser > .serh > b{display:block;font-family:var(--serif);font-size:12.5px;font-weight:600;border-bottom:0.5px solid #999;padding-bottom:3px}
.cl .ser > .serh > b em{font-family:var(--mono);font-style:normal;font-size:10px;color:#666;float:right;font-weight:400;padding-top:2px}
.cl .sn{font-size:10.5px;line-height:1.5;color:#444;margin:5px 0 0;font-style:italic}
.cl .it{
  display:grid;grid-template-columns:0.78in 1fr 0.82in;gap:10px;
  padding:3.5px 0 3.5px 14px;border-bottom:0.25px solid var(--hair);
  align-items:baseline;break-inside:avoid;page-break-inside:avoid;
}
.cl .it:last-child{border-bottom:0}
.cl .it code{font-family:var(--mono);font-size:9.5px;color:#555;font-variant-numeric:lining-nums tabular-nums;word-break:break-all}
.cl .it span{font-size:11px;line-height:1.4}
.cl .it small{font-family:var(--mono);font-size:9.5px;color:#555;text-align:right;font-variant-numeric:lining-nums tabular-nums}
.cl .it.sub{padding-left:30px}
.cl .it.sub span{color:#333}

@media print{
  html,body{background:#fff}
  .scroller{overflow:visible;padding:0}
  .sheet{
    width:auto;min-height:0;margin:0;padding:0;box-shadow:none;
    display:block;break-after:page;page-break-after:always;
  }
  .sheet:last-child{break-after:auto;page-break-after:auto}
  /* The @page margin boxes carry the running head and the folio in
     print, so the sheet's own copies stand down and cannot double. */
  .sheet .run,.sheet .fol{display:none}
  .colo{margin-top:24px}
}

@page{
  size:letter;
  margin:0.64in 0.72in 0.47in;
  @top-left{content:"${cssString(headRepository)}";font-family:"Bricolage Grotesque",sans-serif;font-size:8pt;letter-spacing:0.06em;text-transform:uppercase;color:#767676}
  @top-right{content:"${cssString(headSubject)}";font-family:"Bricolage Grotesque",sans-serif;font-size:8pt;letter-spacing:0.06em;text-transform:uppercase;color:#767676}
  @bottom-left{content:"${cssString(headRepository)}";font-family:"Bricolage Grotesque",sans-serif;font-size:8pt;color:#767676}
  @bottom-right{content:counter(page);font-family:"Bricolage Grotesque",sans-serif;font-size:8pt;color:#767676}
}`;
}

/* @version v0.7.0 */
