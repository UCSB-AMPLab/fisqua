/**
 * Export emitters — one registry, one entry per format
 *
 * This module deals with the seam between the run lifecycle and the
 * things that actually produce bytes. The lifecycle (`run.server.ts`)
 * knows how to insert a ledger row, report a stage, write to R2 and
 * record a failure; it does not know what a CSV is. Each format
 * registers a function here, and adding a format is adding an entry
 * rather than editing the lifecycle.
 *
 * FORM AND FORMAT MEET HERE, AND NOWHERE ELSE. An emitter takes the
 * form as an argument because the two axes are independent by design:
 * the same descriptions leave as an ISAD(G) CSV, a Dublin Core CSV or a
 * canonical CSV, and it is the emitter's job to know which field set
 * the form names. What is NOT its job is deciding whether the pair was
 * allowed — `matrix.ts` settled that before a run row existed.
 *
 * NOT-YET-BUILT FORMATS THROW A NAMED ERROR rather than returning an
 * empty file or a placeholder. A run that could not produce its artifact
 * must land in history as a failed run with an actionable reason; a
 * zero-byte download would be the worst of both worlds. One entry is
 * still a placeholder — the PDF finding aid — and it names the work
 * that fills it.
 *
 * DUBLIN CORE IS A FORM, WHICH IS WHY IT HAS NO ENTRY (ruling 1). It
 * reaches bytes through the CSV and JSON entries like every other form,
 * and the only trace of it here is the branch in `csvEmitter` where a
 * form with no standard behind it takes the crosswalk's own serialiser.
 * Giving it a format entry would have made the two axes non-orthogonal
 * at exactly the place the design separates them.
 *
 * @version v0.7.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Standard } from "../standards/types";
import type { Tenant } from "../../context";
import { emitCanonicalCsv } from "./canonical-csv.server";
import type { ExportArtifact, ExportEmitContext } from "./canonical-csv.server";
import { emitDcCsv } from "./dc-form.server";
import { emitEadXml } from "./ead-xml.server";
import { pdfEmitter } from "./finding-aid.server";
import { emitJson } from "./json.server";
import { standardForForm } from "./forms";
import type { ExportForm, ExportFormat } from "./matrix";
import type { ResolvedExportScope } from "./scopes.server";

export type { ExportArtifact, ExportEmitContext, ExportStage } from "./canonical-csv.server";

/**
 * Re-exported from `./forms`, where it lives so the emitters can reach
 * it without importing the registry that dispatches to them.
 */
export { standardForForm } from "./forms";

/** Everything an emitter is given. Read-only; emitters never write. */
export interface ExportEmitInput {
  db: DrizzleD1Database<any>;
  tenant: Tenant;
  scope: ResolvedExportScope;
  /** The chosen descriptive shape. */
  form: ExportForm;
  /** The workspace's own standard, for the forms that defer to it. */
  ownStandard: Standard;
  includeAuthorities: boolean;
  /**
   * The run being served. The finding aid signs its colophon with it
   * (a finding aid without a run number is one nobody can trust
   * twice), so the lifecycle always supplies it; it is optional here
   * only so the flat-file emitters need not care.
   */
  runId?: string;
  /**
   * The exporting member's language, for artifacts that carry human
   * furniture (the finding aid). Flat data formats ignore it.
   */
  locale?: "en" | "es";
}

export type ExportEmitter = (
  input: ExportEmitInput,
  ctx: ExportEmitContext,
) => Promise<ExportArtifact>;

/**
 * A format (or a form under it) that has no emitter yet. Carries a
 * machine code so the failed history row can say which piece is
 * missing without storing an English sentence.
 */
export class ExportFormatNotBuiltError extends Error {
  readonly code = "format-not-built" as const;
  readonly detail: { format: ExportFormat; form?: ExportForm };
  constructor(format: ExportFormat, form?: ExportForm) {
    super(
      form
        ? `No emitter for ${form} as ${format} yet`
        : `No emitter for ${format} yet`,
    );
    this.name = "ExportFormatNotBuiltError";
    this.detail = { format, form };
  }
}

function notBuilt(format: ExportFormat): ExportEmitter {
  return async () => {
    throw new ExportFormatNotBuiltError(format);
  };
}

/**
 * CSV over any form. A form that resolves to a standard's column
 * projection goes through the canonical emitter; Dublin Core resolves
 * to no standard because it is a fifteen-element crosswalk with its own
 * field set, and goes through its own — same file, same encoding, a
 * different set of columns. This branch IS ruling 1: the format did not
 * change, the form did.
 */
const csvEmitter: ExportEmitter = async (input, ctx) => {
  const standard = standardForForm(input.form, input.ownStandard);
  if (standard === null) return emitDcCsv(input, ctx);
  return emitCanonicalCsv(
    {
      db: input.db,
      tenant: input.tenant,
      scope: input.scope,
      standard,
      includeAuthorities: input.includeAuthorities,
    },
    ctx,
  );
};

/**
 * The registry. All four formats are live. Replace an entry, do not
 * add a branch to the lifecycle.
 */
export const EXPORT_EMITTERS: Record<ExportFormat, ExportEmitter> = {
  csv: csvEmitter,
  // JSON: the same field assembly as the CSV, as objects — canonical
  // and the descriptive standards through the shared column contract,
  // Dublin Core through the same crosswalk the DC CSV uses.
  json: emitJson,
  // EAD XML: the existing builder and per-standard profiles, fed the
  // resolved scope's ordered set rather than only a fonds-rooted slice.
  "ead-xml": emitEadXml,
  // PDF: the print-optimised HTML finding aid, stored rendered so
  // "Open again" serves the snapshot rather than a re-render.
  pdf: pdfEmitter,
};

/* @version v0.7.0 */
