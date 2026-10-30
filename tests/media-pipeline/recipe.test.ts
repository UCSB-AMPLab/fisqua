/**
 * Tests — media pipeline recipe resolution
 *
 * The run spec carries, for every volume, the complete recipe the runner
 * will apply; the runner never fills in a default itself. This suite
 * pins how Fisqua resolves it:
 *
 *   - a volume run takes the preset for the declaration's output class,
 *     then the declaration's advanced parameters, then the per-page
 *     overrides; a tonal declaration with no advanced parameters
 *     resolves to the documented tonal default, carrying the id and
 *     version of the declaration row it came from;
 *   - a bilevel declaration resolves to the bilevel default (Sauvola
 *     binarisation, window 51, k 0.2, CLAHE 2.0), with Tesseract OCR in
 *     the declared language when it asks for OCR;
 *   - OCR runs only for bilevel output, and declaring it on tonal output
 *     or without a language is refused;
 *   - an output class with no preset in the set passed in is refused;
 *   - an advanced parameter the pinned runner version does not accept is
 *     refused by name;
 *   - an item PDF gets the fixed item-PDF recipe whatever the
 *     declaration says about output class, OCR, tone or advanced
 *     parameters, and that recipe passes the spec's recipe schema.
 *
 * The accepted-key lists used here are the parameter names the shared
 * interface lists, as test values; the real lists come from the runner
 * repository for each script version.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import {
  resolveRecipe,
  RecipeError,
  TONAL_DEFAULT_PRESET,
  BILEVEL_DEFAULT_PRESET,
  ITEM_PDF_DPI,
  ITEM_PDF_TONE_PRESET,
  type RecipeDeclaration,
  type RecipePresets,
} from "../../app/lib/pipeline/recipe";
import { runSpecRecipeSchema } from "../../app/lib/pipeline/run-spec";
import smallSpec from "../fixtures/media-pipeline/spec-valid-small.json";

const ACCEPTED = {
  preprocess: [
    "pad", "pad_frac", "clahe_clip", "autolevel_mode", "autolevel_lo", "autolevel_hi",
    "interp", "format", "detect_max_px", "max_fallback_frac",
  ],
  render: [
    "binarise", "sauvola_window", "sauvola_k", "trim", "mask", "margin_frac", "width_tol",
    "format", "dpi",
  ],
};

const presets = (withBilevel = true): RecipePresets => ({
  byOutputClass: withBilevel
    ? { tonal: TONAL_DEFAULT_PRESET, bilevel: BILEVEL_DEFAULT_PRESET }
    : { tonal: TONAL_DEFAULT_PRESET },
  acceptedKeys: ACCEPTED,
});

function declaration(overrides: Partial<RecipeDeclaration> = {}): RecipeDeclaration {
  return {
    id: "decl-1",
    version: 1,
    platen: "v",
    background: "dark",
    outputClass: "tonal",
    ocr: false,
    ocrLang: null,
    tonePreset: "tonal-default",
    advancedParams: "{}",
    ...overrides,
  };
}

describe("recipe resolution", () => {
  it("resolves a tonal declaration with no advanced parameters to the documented default", () => {
    const expected = structuredClone((smallSpec as any).volumes[0].recipe);
    expected.declaration_id = "decl-7";
    expected.declaration_version = 3;
    const recipe = resolveRecipe("volume_run", declaration({ id: "decl-7", version: 3 }), presets(), []);
    expect(recipe).toEqual(expected);
  });

  it("refuses OCR declared on tonal output", () => {
    expect(() =>
      resolveRecipe("volume_run", declaration({ ocr: true, ocrLang: "spa" }), presets(), []),
    ).toThrow(RecipeError);
    try {
      resolveRecipe("volume_run", declaration({ ocr: true, ocrLang: "spa" }), presets(), []);
    } catch (err) {
      expect((err as RecipeError).code).toBe("ocr_requires_bilevel");
    }
  });

  it("refuses an advanced parameter the runner version does not accept, naming it", () => {
    const decl = declaration({ advancedParams: JSON.stringify({ render: { gamma: 1.4 } }) });
    let caught: unknown;
    try {
      resolveRecipe("volume_run", decl, presets(), []);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RecipeError);
    expect((caught as RecipeError).code).toBe("advanced_param_not_accepted");
    expect((caught as RecipeError).message).toContain("gamma");
  });

  it("applies accepted advanced parameters over the preset, stage by stage", () => {
    const decl = declaration({
      advancedParams: JSON.stringify({ preprocess: { clahe_clip: 1.5 }, render: { format: "tiff" } }),
    });
    const recipe = resolveRecipe("volume_run", decl, presets(), []);
    const pre = recipe.stages.preprocess as { run: true; params: Record<string, unknown> };
    const render = recipe.stages.render as { run: true; params: Record<string, unknown> };
    expect(pre.params.clahe_clip).toBe(1.5);
    expect(pre.params.format).toBe("png");
    expect(render.params.format).toBe("tiff");
  });

  it("passes per-page overrides through", () => {
    const overrides = [{ page_key: "p0001", stage: "render" as const, params: { trim: "off" }, verdict_id: "v1" }];
    const recipe = resolveRecipe("volume_run", declaration(), presets(), overrides);
    expect(recipe.page_overrides).toEqual(overrides);
  });

  it("runs Tesseract OCR for a bilevel declaration that asks for it", () => {
    const decl = declaration({ outputClass: "bilevel", ocr: true, ocrLang: "spa", tonePreset: "bilevel-default" });
    const recipe = resolveRecipe("volume_run", decl, presets(), []);
    expect(recipe.stages.ocr).toEqual({ run: true, params: { engine: "tesseract", lang: "spa" } });
    expect(runSpecRecipeSchema.safeParse(recipe).success).toBe(true);
  });

  it("refuses an output class with no preset", () => {
    let caught: unknown;
    try {
      resolveRecipe("volume_run", declaration({ outputClass: "bilevel" }), presets(false), []);
    } catch (err) {
      caught = err;
    }
    expect((caught as RecipeError).code).toBe("preset_unavailable");
  });

  it("gives an item PDF the fixed recipe whatever the declaration says", () => {
    const decl = declaration({
      outputClass: "bilevel",
      ocr: true,
      ocrLang: "spa",
      tonePreset: "bilevel-default",
      advancedParams: JSON.stringify({ render: { gamma: 9 } }),
    });
    const recipe = resolveRecipe("item_pdf", decl, presets(), []);
    expect(recipe.output_class).toBe("tonal");
    expect(recipe.tone_preset).toBe(ITEM_PDF_TONE_PRESET);
    expect(recipe.stages.preprocess.run).toBe(false);
    expect(recipe.stages.render).toEqual({ run: true, params: { dpi: ITEM_PDF_DPI } });
    expect(recipe.stages.ocr).toEqual({ run: true, params: { engine: "pdf_text_layer" } });
    expect(recipe.page_overrides).toEqual([]);
    expect(recipe.capture).toEqual({ platen: "v", background: "dark" });
    expect(runSpecRecipeSchema.safeParse(recipe).success).toBe(true);
  });

  it("resolves a bilevel declaration with OCR to the bilevel default", () => {
    const decl = declaration({ outputClass: "bilevel", ocr: true, ocrLang: "spa", tonePreset: "bilevel-default" });
    const recipe = resolveRecipe("volume_run", decl, presets(), []);
    expect(recipe.output_class).toBe("bilevel");
    expect(recipe.tone_preset).toBe("bilevel-default");
    expect(recipe.stages.preprocess).toEqual({
      run: true,
      params: {
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
    });
    expect(recipe.stages.render).toEqual({
      run: true,
      params: {
        binarise: "sauvola",
        sauvola_window: 51,
        sauvola_k: 0.2,
        trim: "on",
        mask: "require",
        margin_frac: 0.006,
        width_tol: 0.05,
        format: "png",
      },
    });
    expect(recipe.stages.ocr).toEqual({ run: true, params: { engine: "tesseract", lang: "spa" } });
    expect(runSpecRecipeSchema.safeParse(recipe).success).toBe(true);
  });

  it("resolves a bilevel declaration without OCR, recording that OCR was not declared", () => {
    const recipe = resolveRecipe("volume_run", declaration({ outputClass: "bilevel" }), presets(), []);
    expect(recipe.stages.ocr).toEqual({ run: false, reason: "OCR not declared" });
    expect(runSpecRecipeSchema.safeParse(recipe).success).toBe(true);
  });

  it("refuses a bilevel declaration with OCR and no language", () => {
    let caught: unknown;
    try {
      resolveRecipe("volume_run", declaration({ outputClass: "bilevel", ocr: true, ocrLang: null }), presets(), []);
    } catch (err) {
      caught = err;
    }
    expect((caught as RecipeError).code).toBe("ocr_lang_required");
  });

  it.todo("reads the accepted parameter keys for the pinned script version from the runner repository");
});

// @version v0.8.0
