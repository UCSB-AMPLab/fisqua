/**
 * Export legality — which of the three axes' choices can actually meet
 *
 * This module deals with the rule the export surface teaches by
 * dimming: form and format vary independently, but not every pair is a
 * real artifact, and the ones that are not must be unofferable at the
 * point of choice rather than accepted and failed late. It is PURE —
 * no database, no request, no strings a person reads — so the same
 * answer serves the page painting the tiles, the action starting a run,
 * and a test.
 *
 * THREE INPUTS DECIDE EVERYTHING. The record class (what kind of thing
 * the scope holds), the workspace's own descriptive standard, and
 * whether the person may take machine-readable data. Nothing else: a
 * tile's fate never depends on how big the scope is or which door it
 * came through.
 *
 * TWO KINDS OF UNAVAILABILITY, AND THEY ARE NOT THE SAME. A tile is
 * DIMMED when another choice on the page could unlock it — that is the
 * matrix teaching itself, and the tile carries its reason. A tile is
 * ABSENT when the person's role forecloses it, because role is not a
 * choice on the page and dimming it would invite them to go looking for
 * the switch. The re-ruled permission tier (2026-08-15) puts the PDF
 * finding aid in every member's hands and keeps CSV, EAD XML and JSON
 * for admins, so a reader sees three descriptive-standard forms and one
 * format, with no evidence that anything else exists.
 *
 * REASONS ARE MACHINE CODES. Every dim reason here is a stable
 * identifier the surface maps to the card's own sentence in the
 * reader's own language. No English is stored in this module, and a
 * code is never renamed once a locale bundle keys on it.
 *
 * THE RULES, from the design cards:
 *   - EAD XML encodes a finding aid, so it needs a descriptive-standard
 *     form; Dublin Core and canonical cannot render as it.
 *   - The PDF finding aid needs a descriptive-standard form for the
 *     same reason.
 *   - An authority scope has no descriptive-standard form at all
 *     (those standards describe archival materials, not authority
 *     records) and no finding aid of either kind, which leaves
 *     canonical and Dublin Core over CSV and JSON. EAC-CPF is the
 *     standard built for the job and is a LATER CUT — the card shows it
 *     as a proposed aside, and nothing here builds it.
 *
 * @version v0.7.0
 */

import type { Standard } from "../standards/types";

/** The descriptive shapes an export can take. */
export const EXPORT_FORMS = ["isadg", "dacs", "rad", "dc", "canonical"] as const;
export type ExportForm = (typeof EXPORT_FORMS)[number];

/** The serialisations, in the order the DB CHECK lists them. */
export const EXPORT_FORMATS = ["csv", "ead-xml", "json", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Format order as the cards lay the third axis out (export-flow-
 * canonical, export-scope-authority). Separate from `EXPORT_FORMATS`,
 * which mirrors the column CHECK: one is a storage vocabulary, the
 * other is a reading order, and conflating them would make a schema
 * change a design change.
 */
export const ORDERED_EXPORT_FORMATS = ["csv", "json", "ead-xml", "pdf"] as const;

/** What kind of thing a scope holds, in the search tabs' vocabulary. */
export const EXPORT_RECORD_CLASSES = ["records", "entities", "places"] as const;
export type ExportRecordClass = (typeof EXPORT_RECORD_CLASSES)[number];

/** The four What doors, for the door-level legality a typed scope forces. */
export const EXPORT_DOORS = ["workspace", "branch", "carried", "handlist"] as const;
export type ExportDoor = (typeof EXPORT_DOORS)[number];

/** The three forms that are descriptive standards rather than crosswalks. */
export const DESCRIPTIVE_STANDARD_FORMS = ["isadg", "dacs", "rad"] as const;

/** Whether a form is one of the descriptive standards (and so a `Standard`). */
export function isDescriptiveStandardForm(form: ExportForm): form is Standard {
  return (DESCRIPTIVE_STANDARD_FORMS as readonly string[]).includes(form);
}

/** Whether a record class holds authority records rather than descriptions. */
export function isAuthorityClass(recordClass: ExportRecordClass): boolean {
  return recordClass === "entities" || recordClass === "places";
}

/**
 * Why a tile is dimmed. Stable identifiers; the surface holds the copy.
 *
 *   - `descriptive-standard-not-authority` — a descriptive-standard form
 *     under an authority scope.
 *   - `ead-needs-descriptive-standard` — EAD XML under Dublin Core or
 *     canonical, for a records scope.
 *   - `ead-not-authority` — EAD XML under an authority scope. Separate
 *     from the previous code because the card says a different thing:
 *     not "pick another form" but "an authority file is not a finding
 *     aid at all".
 *   - `pdf-needs-descriptive-standard` — the finding aid under any form
 *     that is not a descriptive standard, authority scopes included.
 *   - `door-holds-records` — the whole-workspace door under an
 *     authority scope.
 *   - `door-not-in-hierarchy` — the branch door under an authority
 *     scope.
 */
export const EXPORT_DIM_REASONS = [
  "descriptive-standard-not-authority",
  "ead-needs-descriptive-standard",
  "ead-not-authority",
  "pdf-needs-descriptive-standard",
  "door-holds-records",
  "door-not-in-hierarchy",
] as const;
export type ExportDimReason = (typeof EXPORT_DIM_REASONS)[number];

/**
 * A tile's fate. `absent` tiles are not rendered at all (role); `legal`
 * false tiles are rendered dimmed with their reason (the matrix).
 */
export type ExportTile =
  | { present: false }
  | { present: true; legal: true }
  | { present: true; legal: false; reason: ExportDimReason };

const PRESENT_LEGAL: ExportTile = { present: true, legal: true };

export interface ExportMatrixContext {
  /** What the chosen scope holds. */
  recordClass: ExportRecordClass;
  /** The workspace's own descriptive standard (`tenants.descriptiveStandard`). */
  ownStandard: Standard;
  /** `user.isAdmin` — the tier gate, and the only role input. */
  isAdmin: boolean;
}

/**
 * The permission tier, stated once (ruling 2 as re-ruled): the PDF
 * finding aid is a rendered, descriptive-fields-only artifact any
 * member may take; CSV, EAD XML and JSON are the bulk machine-readable
 * paths, and those are admin-only. Never gated on the `publish`
 * capability or any workspace product tier — the partner's admins are
 * the partner.
 */
export function formatRequiresAdmin(format: ExportFormat): boolean {
  return format !== "pdf";
}

/** The formats a person's role lets them see at all. */
export function availableFormats(isAdmin: boolean): ExportFormat[] {
  return EXPORT_FORMATS.filter((f) => isAdmin || !formatRequiresAdmin(f));
}

/**
 * Is this form legal for this record class, ignoring role and format?
 * The only form-axis rule: an authority scope has no descriptive
 * standard, because those standards describe archival materials.
 */
function formLegality(
  form: ExportForm,
  recordClass: ExportRecordClass,
): ExportDimReason | null {
  if (isAuthorityClass(recordClass) && isDescriptiveStandardForm(form)) {
    return "descriptive-standard-not-authority";
  }
  return null;
}

/**
 * Is this format legal under this form and record class, ignoring role?
 * Both encoded artifacts need a descriptive-standard form; under an
 * authority scope EAD says so in the scope's own terms rather than
 * pointing at the form axis.
 */
function formatLegality(
  format: ExportFormat,
  form: ExportForm,
  recordClass: ExportRecordClass,
): ExportDimReason | null {
  const descriptive = isDescriptiveStandardForm(form);
  if (format === "ead-xml") {
    if (isAuthorityClass(recordClass)) return "ead-not-authority";
    return descriptive ? null : "ead-needs-descriptive-standard";
  }
  if (format === "pdf") {
    if (isAuthorityClass(recordClass)) return "pdf-needs-descriptive-standard";
    return descriptive ? null : "pdf-needs-descriptive-standard";
  }
  // CSV and JSON carry any form: they serialise a field set, and every
  // form is a field set.
  return null;
}

/**
 * Whether a pair is legal on its own terms — the matrix, with no role
 * in it. `startExportRun` calls the asserting form of this; the surface
 * calls the tile builders.
 */
export function isCombinationLegal(
  context: ExportMatrixContext,
  form: ExportForm,
  format: ExportFormat,
): boolean {
  if (formLegality(form, context.recordClass) !== null) return false;
  if (formatLegality(format, form, context.recordClass) !== null) return false;
  return !(formatRequiresAdmin(format) && !context.isAdmin);
}

/** A refused combination, carrying the machine code the surface maps. */
export class ExportCombinationError extends Error {
  readonly code:
    | ExportDimReason
    /** The role forecloses the format; the tile was never offered. */
    | "format-requires-admin";
  constructor(code: ExportCombinationError["code"], message: string) {
    super(message);
    this.name = "ExportCombinationError";
    this.code = code;
  }
}

/**
 * Refuse an illegal pair before a run row exists. A crafted form body
 * can name any pair; this is the server-side copy of what the tiles
 * showed, and the reason it throws is the reason the tile would have
 * carried.
 */
export function assertCombinationLegal(
  context: ExportMatrixContext,
  form: ExportForm,
  format: ExportFormat,
): void {
  const formReason = formLegality(form, context.recordClass);
  if (formReason !== null) {
    throw new ExportCombinationError(
      formReason,
      `Form ${form} is not legal for a ${context.recordClass} scope`,
    );
  }
  const formatReason = formatLegality(format, form, context.recordClass);
  if (formatReason !== null) {
    throw new ExportCombinationError(
      formatReason,
      `Format ${format} is not legal for the ${form} form`,
    );
  }
  if (formatRequiresAdmin(format) && !context.isAdmin) {
    throw new ExportCombinationError(
      "format-requires-admin",
      `Format ${format} is available to workspace admins only`,
    );
  }
}

/**
 * The form tile. A form is ABSENT when the person's role leaves it no
 * legal format at all — a reader offered a Dublin Core tile that no
 * format they can see could carry would be reading the role gate off
 * the page, which is exactly what the absence rule forbids.
 */
export function formTile(
  context: ExportMatrixContext,
  form: ExportForm,
): ExportTile {
  const reason = formLegality(form, context.recordClass);
  if (reason !== null) return { present: true, legal: false, reason };
  const reachable = availableFormats(context.isAdmin).some(
    (format) => formatLegality(format, form, context.recordClass) === null,
  );
  return reachable ? PRESENT_LEGAL : { present: false };
}

/**
 * The format tile, under a chosen form. Absent by role, dimmed by the
 * matrix, and never both — the role check runs first, because a tile
 * the person may not have is not a tile with a reason.
 */
export function formatTile(
  context: ExportMatrixContext,
  form: ExportForm,
  format: ExportFormat,
): ExportTile {
  if (formatRequiresAdmin(format) && !context.isAdmin) return { present: false };
  const reason = formatLegality(format, form, context.recordClass);
  return reason === null ? PRESENT_LEGAL : { present: true, legal: false, reason };
}

/**
 * A What door's tile. Only an authority scope closes doors: the whole
 * workspace holds records rather than authority records, and authority
 * records do not sit in the archival hierarchy at all. Carried and
 * handlist doors stay open for every class — they are typed by what was
 * put in them.
 */
export function doorTile(
  door: ExportDoor,
  recordClass: ExportRecordClass,
): ExportTile {
  if (!isAuthorityClass(recordClass)) return PRESENT_LEGAL;
  if (door === "workspace") {
    return { present: true, legal: false, reason: "door-holds-records" };
  }
  if (door === "branch") {
    return { present: true, legal: false, reason: "door-not-in-hierarchy" };
  }
  return PRESENT_LEGAL;
}

/**
 * The forms in reading order: the workspace's own standard first (it is
 * the lossless one), then the other two standards as crosswalks, then
 * Dublin Core, then canonical. Under an authority scope the cards
 * reverse the tail — canonical, then Dublin Core — because those two
 * are the only live choices and canonical is the round trip.
 */
export function orderedForms(context: ExportMatrixContext): ExportForm[] {
  if (isAuthorityClass(context.recordClass)) {
    return [
      "canonical",
      "dc",
      ...DESCRIPTIVE_STANDARD_FORMS.filter((f) => f === context.ownStandard),
      ...DESCRIPTIVE_STANDARD_FORMS.filter((f) => f !== context.ownStandard),
    ];
  }
  return [
    context.ownStandard,
    ...DESCRIPTIVE_STANDARD_FORMS.filter((f) => f !== context.ownStandard),
    "dc",
    "canonical",
  ];
}

/** Whether a form leaves the workspace's own shape intact (no crosswalk loss). */
export function isLosslessForm(
  context: ExportMatrixContext,
  form: ExportForm,
): boolean {
  return form === context.ownStandard || form === "canonical";
}

/** One axis, resolved: every choice with its tile, in reading order. */
export interface ExportMatrixView {
  forms: { form: ExportForm; tile: ExportTile; lossless: boolean }[];
  /** Keyed by form — the format axis is only meaningful under one. */
  formats: Record<ExportForm, { format: ExportFormat; tile: ExportTile }[]>;
  doors: { door: ExportDoor; tile: ExportTile }[];
  /** False when the person's role and this scope leave nothing to take. */
  anyLegalCombination: boolean;
}

/**
 * The whole matrix in one read, for a surface that paints all three
 * axes at once. Building it per-tile in the page would scatter the
 * rules across JSX; building it here keeps the page a renderer.
 */
export function exportMatrix(context: ExportMatrixContext): ExportMatrixView {
  const forms = orderedForms(context).map((form) => ({
    form,
    tile: formTile(context, form),
    lossless: isLosslessForm(context, form),
  }));

  const formats = {} as ExportMatrixView["formats"];
  for (const form of EXPORT_FORMS) {
    formats[form] = ORDERED_EXPORT_FORMATS.map((format) => ({
      format,
      tile: formatTile(context, form, format),
    }));
  }

  const anyLegalCombination = EXPORT_FORMS.some((form) =>
    EXPORT_FORMATS.some((format) => isCombinationLegal(context, form, format)),
  );

  return {
    forms,
    formats,
    doors: EXPORT_DOORS.map((door) => ({
      door,
      tile: doorTile(door, context.recordClass),
    })),
    anyLegalCombination,
  };
}

/* @version v0.7.0 */
