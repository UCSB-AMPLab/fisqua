/**
 * Export labels — where machine codes become sentences
 *
 * Every module under `app/lib/export/` speaks in stable identifiers:
 * the legality matrix dims a tile with `ead-not-authority`, the scope
 * resolver refuses a door with `handlist-needs-review`, a run records
 * its failure as `duplicate-reference-code`. None of them holds a word
 * a person reads, which is what lets the same answer serve a test, a
 * loader and two languages. This module is the one place those codes
 * turn into locale keys, so a renamed code breaks in one file rather
 * than in six components.
 *
 * COUNT PHRASES ARE BUILT HERE TOO, and for the same reason the locale
 * bundle keeps one key per kind of thing: "1,204 records" and "412
 * entities" are not one sentence with a noun slot. `useExportLabels`
 * hands back a small set of composers that take a number and give back
 * a phrase already plural-correct and already grouped for the reader's
 * locale — `{{count}}` alone would print `1204` in a surface whose
 * whole point is that the numbers are exact and readable.
 *
 * The field codes the crosswalk loss report names arrive from the loss
 * computation as canonical field identifiers. They are normalised to a
 * `field…` locale key here; a code with no key falls back to the code
 * itself rather than rendering an empty string, because a cataloguer
 * reading `custodial_history` still learns which field was dropped,
 * and a blank teaches nothing.
 *
 * @version v0.7.0
 */
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "~/lib/use-formatters";
import type {
  ExportDimReason,
  ExportDoor,
  ExportForm,
  ExportFormat,
  ExportRecordClass,
} from "~/lib/export/matrix";
import type { ExportScopeDescriptor } from "~/lib/export/scopes.server";

/** The three kinds of thing a scope can hold, plus what rides along. */
export type CountKind =
  | "records"
  | "entities"
  | "places"
  | "links"
  | "series"
  | "collections";

const COUNT_KEYS: Record<CountKind, string> = {
  records: "countRecords",
  entities: "countEntities",
  places: "countPlaces",
  links: "countLinks",
  series: "countSeries",
  collections: "countCollections",
};

export const FORM_KEYS: Record<ExportForm, string> = {
  isadg: "formIsadg",
  dacs: "formDacs",
  rad: "formRad",
  dc: "formDc",
  canonical: "formCanonical",
};

export const FORMAT_KEYS: Record<ExportFormat, string> = {
  csv: "formatCsv",
  "ead-xml": "formatEad",
  json: "formatJson",
  pdf: "formatPdf",
};

/** The format subtitle on the third axis. CSV's changes under canonical. */
export const FORMAT_SUB_KEYS: Record<ExportFormat, string> = {
  csv: "formatCsvSub",
  "ead-xml": "formatEadSub",
  json: "formatJsonSub",
  pdf: "formatPdfSub",
};

/** The format's own words on the dialog's Format row. */
export const FORMAT_ROW_KEYS: Record<ExportFormat, string> = {
  csv: "rowFormatCsv",
  "ead-xml": "rowFormatEad",
  json: "rowFormatJson",
  pdf: "rowFormatPdf",
};

/** What the serialisation stage is writing, per format. */
export const ARTIFACT_KEYS: Record<ExportFormat, string> = {
  csv: "artifactCsv",
  "ead-xml": "artifactEad",
  json: "artifactJson",
  pdf: "artifactPdf",
};

export const DOOR_KEYS: Record<ExportDoor, string> = {
  workspace: "doorWorkspace",
  branch: "doorBranch",
  carried: "doorCarried",
  handlist: "doorHandlist",
};

/** The matrix's dim reasons, in the cards' own words. */
export const DIM_REASON_KEYS: Record<ExportDimReason, string> = {
  "descriptive-standard-not-authority": "reasonDescriptiveStandardNotAuthority",
  "ead-needs-descriptive-standard": "reasonEadNeedsDescriptiveStandard",
  "ead-not-authority": "reasonEadNotAuthority",
  "pdf-needs-descriptive-standard": "reasonPdfNeedsDescriptiveStandard",
  "door-holds-records": "reasonDoorHoldsRecords",
  "door-not-in-hierarchy": "reasonDoorNotInHierarchy",
};

/**
 * Every failure a run can record, from three sources: the emitters
 * (`duplicate-reference-code`, `format-not-built`), the run lifecycle
 * (`unexpected`, `workspace-standard-unset`), and the scope resolver's
 * refusals, which reach a row when a scope decayed between the choice
 * and the run.
 *
 * `format-not-built` is transient by design — D2 and D4 are filling
 * the unbuilt emitters — but the key stays afterwards, because an
 * emitter can be added to the registry ahead of its format again.
 */
const FAILURE_KEYS: Record<string, string> = {
  "duplicate-reference-code": "failureDuplicateReferenceCode",
  "format-not-built": "failureFormatNotBuilt",
  "workspace-standard-unset": "failureWorkspaceStandardUnset",
  "format-requires-admin": "failureFormatRequiresAdmin",
  "handlist-needs-review": "failureHandlistNeedsReview",
  "handlist-empty": "failureHandlistEmpty",
  "handlist-untyped": "failureHandlistUntyped",
  "branch-not-found": "failureBranchNotFound",
  "scope-empty": "failureScopeEmpty",
  "descriptive-standard-not-authority": "failureIllegalCombination",
  "ead-needs-descriptive-standard": "failureIllegalCombination",
  "ead-not-authority": "failureIllegalCombination",
  "pdf-needs-descriptive-standard": "failureIllegalCombination",
  "door-holds-records": "failureIllegalCombination",
  "door-not-in-hierarchy": "failureIllegalCombination",
  unexpected: "failureUnexpected",
};

/** The key for a recorded failure code; anything unnamed reads as unexpected. */
export function failureKey(code: string | null | undefined): string {
  if (!code) return "failureUnexpected";
  return FAILURE_KEYS[code] ?? "failureUnexpected";
}

/**
 * A canonical field code as the locale bundle keys it:
 * `custodial_history`, `custodialHistory` and `custodial-history` all
 * reach `fieldCustodialHistory`.
 */
export function fieldKey(code: string): string {
  const camel = code
    .replace(/[-_\s]+(.)/g, (_m, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_m, c: string) => c.toUpperCase());
  return `field${camel}`;
}

/** What a scope of this class counts as, for the phrases keyed on it. */
export function primaryKind(recordClass: ExportRecordClass): CountKind {
  if (recordClass === "entities") return "entities";
  if (recordClass === "places") return "places";
  return "records";
}

export interface ExportLabels {
  /** "1,204 records" — plural-correct, locale-grouped. */
  count: (kind: CountKind, n: number) => string;
  /** The scope's own kind: records, entities or places. */
  primary: (recordClass: ExportRecordClass, n: number) => string;
  /** A bare grouped number, for the arithmetic block and progress. */
  number: (n: number) => string;
  /**
   * The consequence line. Records scopes name their records and, when
   * the authorities ride along, the authorities too; an authority
   * scope names both authority kinds (zero included — "14 entities, 0
   * places") and its description links.
   */
  counts: (
    recordClass: ExportRecordClass,
    counts: { records: number; entities: number; places: number; links: number },
    options?: {
      includeAuthorities?: boolean;
      separator?: string;
      /**
       * Whether the description-link count is known. A run row stores
       * its three counts and not its links, so a history row says what
       * it has rather than printing a zero it never counted.
       */
      links?: boolean;
    },
  ) => string;
}

/**
 * The composers, bound to the reader's language. A hook rather than a
 * set of functions taking `t` because every consumer is a component
 * and threading `t` and `formatNumber` through four levels of props
 * was how the ungrouped numbers got in last time.
 */
export function useExportLabels(): ExportLabels {
  const { t } = useTranslation("exports");
  const { formatNumber } = useFormatters();

  const count = useCallback(
    (kind: CountKind, n: number) =>
      t(COUNT_KEYS[kind], { count: n, formatted: formatNumber(n) }),
    [t, formatNumber],
  );

  const counts = useCallback<ExportLabels["counts"]>(
    (recordClass, values, options) => {
      const separator = options?.separator ?? " · ";
      const parts: string[] = [];
      if (recordClass === "records") {
        parts.push(count("records", values.records));
        if (options?.includeAuthorities !== false) {
          parts.push(count("entities", values.entities));
          parts.push(count("places", values.places));
        }
        return parts.join(separator);
      }
      // An authority scope states both kinds even when one is zero —
      // "14 entities, 0 places" says what this scope is not, which is
      // the thing a mixed selection would otherwise hide.
      parts.push(count("entities", values.entities));
      parts.push(count("places", values.places));
      if (options?.links === false) return parts.join(separator);
      return `${parts.join(separator)}${separator}${t("andTheirLinks", {
        links: count("links", values.links),
      })}`;
    },
    [count, t],
  );

  return useMemo(
    () => ({
      count,
      primary: (recordClass, n) => count(primaryKind(recordClass), n),
      number: formatNumber,
      counts,
    }),
    [count, counts, formatNumber],
  );
}

export interface ScopeText {
  /** The scope in its own words — the ledger row and the history row. */
  summary: (descriptor: ExportScopeDescriptor | null) => string;
  /** The second line: when a query ran, or where a branch sits. */
  note: (descriptor: ExportScopeDescriptor | null) => string | null;
}

/**
 * A scope descriptor as the surface says it. The descriptor is the
 * ledger row's own words, frozen when the run started, so this never
 * re-reads anything: renaming a branch or editing a handlist cannot
 * rewrite what a recorded run says it took.
 *
 * User content is not translated. A handlist's name and a search's
 * pills appear exactly as they were typed, in whichever language they
 * were typed.
 */
export function useScopeText(): ScopeText {
  const { t } = useTranslation("exports");

  return useMemo(
    () => ({
      summary: (descriptor) => {
        if (descriptor === null) return t("scopeSelection");
        switch (descriptor.kind) {
          case "workspace":
            return t("scopeWorkspace");
          case "branch":
            return descriptor.title || descriptor.referenceCode;
          case "carried":
            return descriptor.pills.length > 0
              ? descriptor.pills.join(" · ")
              : t("scopeSelection");
          case "handlist":
            return descriptor.name;
        }
      },
      note: (descriptor) => {
        if (descriptor === null) return null;
        switch (descriptor.kind) {
          case "branch":
            return descriptor.referenceCode || null;
          case "carried":
            return t("carriedRunStamp", {
              stamp: new Date(descriptor.carriedAt)
                .toISOString()
                .slice(0, 16)
                .replace("T", " "),
            });
          default:
            return null;
        }
      },
    }),
    [t],
  );
}

/* @version v0.7.0 */
