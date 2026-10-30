/**
 * Media Pipeline — Recipe Resolution
 *
 * This module deals with turning a collection's recipe declaration into
 * the complete recipe the runner applies to one volume. The run spec
 * carries the resolved recipe, never the declaration: the runner fills
 * in no default of its own, so what the spec says is what was applied,
 * and the run ledger stores the same object.
 *
 * `resolveRecipe(kind, declaration, presets, overrides)` is pure. The
 * declaration is the row a run resolved from the volume's declaration
 * family, and the recipe carries that row's id and version.
 *
 * For a volume run the values cascade in three layers. The preset for
 * the declaration's output class comes first; then the declaration's
 * advanced parameters, which are stage-qualified
 * (`{ "preprocess": {...}, "render": {...} }`, because the same
 * parameter name exists in more than one stage) and are accepted only
 * when the pinned runner version lists the key; then the per-page
 * overrides, keyed by canonical page key. OCR runs, with Tesseract and
 * the declared language, only for bilevel output that asks for it;
 * declaring OCR on tonal output is refused, because OCR applies to
 * bilevel printed material only. Tiling always runs with the fixed
 * Level 0 parameters.
 *
 * An item PDF gets a fixed recipe: tonal output, no preprocessing, the
 * PDF rendered at `ITEM_PDF_DPI`, OCR read from the PDF's own text
 * layer, the same tiling, no overrides, and the `ITEM_PDF_TONE_PRESET`
 * name. Of the declaration only the capture fields and its id and
 * version are used; its output class, OCR, tone preset and advanced
 * parameters do not apply.
 *
 * Presets and the accepted-key lists are passed in. `TONAL_DEFAULT_PRESET`
 * and `BILEVEL_DEFAULT_PRESET` hold the two output classes' defaults.
 * The bilevel default binarises with Sauvola (window 51, k 0.2) and
 * applies CLAHE at 2.0; every other key takes the tonal value, which is
 * the runner's script default. The per-version accepted keys come from
 * the runner repository. An output class with no preset in the set
 * passed in is refused with `preset_unavailable`. A refused input
 * throws a `RecipeError` with a code.
 *
 * @version v0.8.0
 */

import type { PipelineOutputClass, PipelineRunKind } from "../validation/enums";
import type { RunSpecRecipe } from "./run-spec";

/** The render resolution of an item PDF, in dots per inch. Provisional. */
export const ITEM_PDF_DPI = 300;
/** The tone preset name an item PDF's recipe records. Provisional. */
export const ITEM_PDF_TONE_PRESET = "item-pdf";

const TILE_STAGE = {
  run: true as const,
  params: { tile_size: 512, layout: "iiif3", thumbnail_widths: [96, 200] },
};

type Params = Record<string, unknown>;

/** The preprocess and render parameters of one output class's preset. */
export interface RecipePreset {
  preprocess: Params;
  render: Params;
}

/** The documented tonal default. */
export const TONAL_DEFAULT_PRESET: RecipePreset = {
  preprocess: {
    pad: 4,
    pad_frac: 0.015,
    clahe_clip: 1.2,
    autolevel_mode: "uniform",
    autolevel_lo: 2.0,
    autolevel_hi: 98.0,
    interp: "linear",
    format: "png",
    detect_max_px: 1000,
    max_fallback_frac: 1.0,
  },
  render: {
    binarise: "none",
    trim: "on",
    mask: "require",
    margin_frac: 0.006,
    width_tol: 0.05,
    format: "png",
  },
};

/** The bilevel default: Sauvola binarisation, CLAHE 2.0. */
export const BILEVEL_DEFAULT_PRESET: RecipePreset = {
  preprocess: {
    pad: 4,
    pad_frac: 0.015,
    clahe_clip: 2.0,
    autolevel_mode: "uniform",
    autolevel_lo: 2.0,
    autolevel_hi: 98.0,
    interp: "linear",
    format: "png",
    detect_max_px: 1000,
    max_fallback_frac: 1.0,
  },
  render: {
    binarise: "sauvola",
    sauvola_window: 51,
    sauvola_k: 0.2,
    trim: "on",
    mask: "require",
    margin_frac: 0.006,
    width_tol: 0.05,
    format: "png",
  },
};

export interface RecipePresets {
  byOutputClass: Partial<Record<PipelineOutputClass, RecipePreset>>;
  /** The parameter keys the pinned runner version accepts, per stage. */
  acceptedKeys: { preprocess: readonly string[]; render: readonly string[] };
}

/** The declaration row fields a recipe is resolved from. */
export interface RecipeDeclaration {
  id: string;
  version: number;
  platen: RunSpecRecipe["capture"]["platen"];
  background: RunSpecRecipe["capture"]["background"];
  outputClass: PipelineOutputClass;
  ocr: boolean;
  ocrLang: string | null;
  tonePreset: string;
  /** JSON text, stage-qualified. */
  advancedParams: string;
}

export type RecipePageOverride = RunSpecRecipe["page_overrides"][number];

export type RecipeErrorCode =
  | "ocr_requires_bilevel"
  | "ocr_lang_required"
  | "preset_unavailable"
  | "advanced_params_invalid"
  | "advanced_param_not_accepted";

export class RecipeError extends Error {
  readonly code: RecipeErrorCode;
  constructor(code: RecipeErrorCode, message: string) {
    super(message);
    this.name = "RecipeError";
    this.code = code;
  }
}

const ADVANCED_STAGES = ["preprocess", "render"] as const;

function advancedParams(
  declaration: RecipeDeclaration,
  accepted: RecipePresets["acceptedKeys"],
): { preprocess: Params; render: Params } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(declaration.advancedParams || "{}");
  } catch {
    throw new RecipeError("advanced_params_invalid", "Advanced parameters are not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RecipeError("advanced_params_invalid", "Advanced parameters must be an object");
  }
  const out = { preprocess: {} as Params, render: {} as Params };
  for (const [stage, params] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(ADVANCED_STAGES as readonly string[]).includes(stage)) {
      throw new RecipeError(
        "advanced_param_not_accepted",
        `Advanced parameters for stage "${stage}" are not accepted`,
      );
    }
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new RecipeError("advanced_params_invalid", `Advanced parameters for ${stage} must be an object`);
    }
    const allowed = accepted[stage as (typeof ADVANCED_STAGES)[number]];
    for (const [key, value] of Object.entries(params as Params)) {
      if (!allowed.includes(key)) {
        throw new RecipeError(
          "advanced_param_not_accepted",
          `The runner version does not accept the ${stage} parameter "${key}"`,
        );
      }
      out[stage as (typeof ADVANCED_STAGES)[number]][key] = value;
    }
  }
  return out;
}

export function resolveRecipe(
  kind: PipelineRunKind,
  declaration: RecipeDeclaration,
  presets: RecipePresets,
  overrides: RecipePageOverride[],
): RunSpecRecipe {
  const head = {
    declaration_id: declaration.id,
    declaration_version: declaration.version,
    capture: { platen: declaration.platen, background: declaration.background },
  };

  if (kind === "item_pdf") {
    return {
      ...head,
      output_class: "tonal",
      tone_preset: ITEM_PDF_TONE_PRESET,
      stages: {
        preprocess: { run: false, reason: "item PDF: pages are rendered from the PDF" },
        render: { run: true, params: { dpi: ITEM_PDF_DPI } },
        ocr: { run: true, params: { engine: "pdf_text_layer" } },
        tile: structuredClone(TILE_STAGE),
      },
      page_overrides: [],
    };
  }

  const outputClass = declaration.outputClass;
  if (declaration.ocr && outputClass !== "bilevel") {
    throw new RecipeError(
      "ocr_requires_bilevel",
      `OCR is declared on ${outputClass} output; it applies to bilevel output only`,
    );
  }
  const preset = presets.byOutputClass[outputClass];
  if (!preset) {
    throw new RecipeError("preset_unavailable", `No preset is configured for ${outputClass} output`);
  }
  const advanced = advancedParams(declaration, presets.acceptedKeys);

  let ocr: RunSpecRecipe["stages"]["ocr"];
  if (declaration.ocr) {
    if (!declaration.ocrLang) {
      throw new RecipeError("ocr_lang_required", "OCR is declared without a language");
    }
    ocr = { run: true, params: { engine: "tesseract", lang: declaration.ocrLang } };
  } else if (outputClass === "tonal") {
    ocr = { run: false, reason: "output_class tonal: OCR applies to bilevel printed material only" };
  } else {
    ocr = { run: false, reason: "OCR not declared" };
  }

  return {
    ...head,
    output_class: outputClass,
    tone_preset: declaration.tonePreset,
    stages: {
      preprocess: { run: true, params: { ...preset.preprocess, ...advanced.preprocess } },
      render: { run: true, params: { ...preset.render, ...advanced.render } },
      ocr,
      tile: structuredClone(TILE_STAGE),
    },
    page_overrides: overrides.map((o) => structuredClone(o)),
  };
}

// @version v0.8.0
