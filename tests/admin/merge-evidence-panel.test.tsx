/**
 * Tests — the evidence panel, the pair-merge dialog and the duplicate card's chips
 *
 * This suite pins the evidence panel, the pair-merge dialog and the
 * duplicate card's chips. A merge of two entity records waits on its
 * evidence: a fact ticked and a description chosen for each record. The
 * suite pins the panel's five facts in order with the line that a name
 * alone is not enough, the hidden inputs it emits for the server
 * (`evidence_fact`, `evidence_description` as
 * `<entityId>:<descriptionId>`), the rule the Merge button waits on
 * (`evidenceReady`), the facts heading and the no-fact refusal worded by
 * what the records are (`evidenceShape`), the pruning of citations a
 * reload no longer offers (`pruneEvidence`), the dialog's confirm disabled
 * while the evidence is incomplete, a place merge's dialog with no panel,
 * and the duplicates card's chips for what the scan found, overlapping
 * dates with both spans among them, and the open dialog's pair read from
 * the loader's current data (`currentPair`) with its descriptions from the
 * evidence route (`evidenceSidesFor`), and the dialog's loading line until
 * the evidence route has answered.
 *
 * Rendered with `renderToStaticMarkup` over the real locale bundles, as
 * `tests/admin/decision-pair-render.test.tsx` does. Static markup runs
 * the first render only, so the dialogs are rendered in their initial
 * state and the panel with a fixed value.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub } from "react-router";
import resources from "../../app/locales";
import {
  MergeEvidencePanel,
  evidenceFormEntries,
  evidenceErrorKey,
  evidenceReady,
  evidenceShape,
  pruneEvidence,
  type EvidenceSide,
} from "../../app/components/admin/merge-evidence-panel";
import { PairMergeDialog } from "../../app/components/admin/pair-merge-dialog";
import DecisionDuplicatesPage, {
  currentPair,
  evidencePath,
  evidenceSidesFor,
  evidenceGone,
  evidenceToLoad,
  type PairView,
} from "../../app/routes/_auth.admin.decisions.duplicates";

async function makeI18n(lang: "en" | "es") {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: lang,
    fallbackLng: "es",
    defaultNS: "common",
    resources,
    interpolation: { escapeValue: false },
  });
  return inst;
}

async function render(node: React.ReactElement, lang: "en" | "es" = "en") {
  const inst = await makeI18n(lang);
  const Stub = createRoutesStub([{ path: "/", Component: () => node }]);
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: inst }, React.createElement(Stub, { initialEntries: ["/"] })),
  );
}

const SIDES: [EvidenceSide, EvidenceSide] = [
  {
    entityId: "ent-a",
    name: "Domingo Caycedo",
    code: "ne-a",
    descriptions: [
      { id: "d1", code: "co-cihjml-acc-00044", date: "1835-05", title: "Causa criminal" },
      { id: "d2", code: "co-cihjml-acc-07209", date: null, title: "Pleito civil" },
    ],
  },
  { entityId: "ent-b", name: "Domingo Caicedo", code: "ne-b", descriptions: [{ id: "d3", code: "co-cihjml-acc-00057", date: "1835-05", title: "Causa criminal" }] },
];

const noop = () => {};

describe("the merge evidence panel", () => {
  it("Merge disabled until a fact and a description per side", async () => {
    expect(evidenceReady({ facts: [], cited: { "ent-a": ["d1"], "ent-b": ["d3"] } }, SIDES)).toBe(false);
    expect(evidenceReady({ facts: ["dates"], cited: { "ent-a": ["d1"] } }, SIDES)).toBe(false);
    expect(evidenceReady({ facts: ["dates"], cited: { "ent-a": ["d1"], "ent-b": [] } }, SIDES)).toBe(false);
    expect(evidenceReady({ facts: ["dates"], cited: { "ent-a": ["d1"], "ent-b": ["d3"] } }, SIDES)).toBe(true);

    // The dialog opens with the survivor chosen and no evidence: Merge is disabled.
    const html = await render(
      React.createElement(PairMergeDialog, {
        title: "Merge",
        options: [{ code: "ne-a", loadLine: "2" }, { code: "ne-b", loadLine: "1" }],
        defaultSurvivorCode: "ne-a",
        reasonPlaceholder: "",
        evidence: { sides: SIDES },
        onCancel: noop,
        onConfirm: noop,
      }),
    );
    expect(html).toContain('data-testid="merge-evidence-panel"');
    expect(html).toMatch(/<button type="button" disabled="" class="[^"]*bg-madder[^"]*">Merge records<\/button>/);
    expect(html).toContain("Note (optional)");
    expect(html).not.toContain("Reason (optional)");
  });

  it("emits the hidden inputs", async () => {
    const value = { facts: ["matter", "dates"] as const, cited: { "ent-a": ["d1", "d2"], "ent-b": ["d3"] } };
    const html = await render(
      React.createElement(MergeEvidencePanel, { sides: SIDES, value: { ...value, facts: [...value.facts] }, onChange: noop }),
    );
    // The five facts, in order, and the line under them.
    const facts = [...html.matchAll(/<input[^>]*name="evidence-fact-choice"[^>]*>/g)].map((m) => /value="([a-z]+)"/.exec(m[0])![1]);
    expect(facts).toEqual(["dates", "office", "kin", "place", "matter"]);
    expect(html).toContain("A name alone is not enough");
    expect(html).toContain("co-cihjml-acc-07209");
    // The hidden fields the server reads, facts in the panel's order.
    const hidden = [...html.matchAll(/<input type="hidden" name="(evidence_[a-z]+)" value="([^"]+)"\/>/g)].map((m) => [m[1], m[2]]);
    expect(hidden).toEqual([
      ["evidence_fact", "dates"],
      ["evidence_fact", "matter"],
      ["evidence_description", "ent-a:d1"],
      ["evidence_description", "ent-a:d2"],
      ["evidence_description", "ent-b:d3"],
    ]);
    expect(evidenceFormEntries({ facts: ["matter", "dates"], cited: { "ent-a": ["d1"] } })).toEqual([
      ["evidence_fact", "dates"], ["evidence_fact", "matter"], ["evidence_description", "ent-a:d1"],
    ]);
  });

  it("keeps a description row within the dialog: code and date wrap, the title is cut with its full text in a title", async () => {
    const long = "Causa criminal contra Domingo Caycedo por injurias y calumnias al alcalde ordinario de la villa";
    const sides: EvidenceSide[] = [{ ...SIDES[0], descriptions: [{ id: "d1", code: "co-cihjml-acc-00044-judicial-i-cr", date: "1835-05", title: long }] }];
    const html = await render(React.createElement(MergeEvidencePanel, { sides, value: { facts: [], cited: {} }, onChange: noop }));
    // The fieldsets and rows may shrink below their content's width.
    expect(html.match(/<fieldset class="min-w-0">/g)).toHaveLength(2);
    expect(html).toMatch(/<label class="flex min-w-0 [^"]*">/);
    // The code breaks anywhere rather than pushing the row wider.
    expect(html).toMatch(/<span class="min-w-0 break-all font-mono[^"]*">co-cihjml-acc-00044-judicial-i-cr<\/span>/);
    // The title is on its own line, truncated, its full text in the title attribute.
    expect(html).toContain(`<span class="block truncate text-13 text-stone-700" title="${long}">${long}</span>`);
  });

  it("heads each list with the record's name and code, and marks the side the dialog's direction keeps", async () => {
    const same: [EvidenceSide, EvidenceSide] = [{ ...SIDES[0], name: "Agustín Correa" }, { ...SIDES[1], name: "Agustín Correa" }];
    const dialog = (defaultSurvivorCode: string | null, lang: "en" | "es" = "en") =>
      render(
        React.createElement(PairMergeDialog, {
          title: "Merge",
          options: [{ code: "ne-a", loadLine: "2" }, { code: "ne-b", loadLine: "1" }],
          defaultSurvivorCode,
          reasonPlaceholder: "",
          evidence: { sides: same },
          onCancel: noop,
          onConfirm: noop,
        }),
        lang,
      );
    const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const html = text(await dialog("ne-b"));
    expect(html).toContain("Agustín Correa · ne-a Retired");
    expect(html).toContain("Agustín Correa · ne-b Survives");
    // No direction chosen yet: the codes tell the lists apart, and neither is marked.
    const open = text(await dialog(null));
    expect(open).toMatch(/Agustín Correa · ne-a (?!Retired|Survives)/);
    expect(text(await dialog("ne-a", "es"))).toContain("Agustín Correa · ne-a Sobrevive");
  });

  it("says so for a record with no descriptions to cite, in Spanish too", async () => {
    const sides: EvidenceSide[] = [SIDES[0], { entityId: "ent-c", name: "Sin descripciones", descriptions: [] }];
    const en = await render(React.createElement(MergeEvidencePanel, { sides, value: { facts: [], cited: {} }, onChange: noop }));
    expect(en).toContain("there is nothing to cite");
    const es = await render(React.createElement(MergeEvidencePanel, { sides, value: { facts: [], cited: {} }, onChange: noop }), "es");
    expect(es).toContain("Un nombre por sí solo no basta");
    expect(es).toContain("Sin una descripción que citar");
  });

  it("drops a citation whose description is no longer offered, so a later submit does not post it", () => {
    const chosen = { facts: ["dates" as const], cited: { "ent-a": ["d1", "d2"], "ent-b": ["d3"] } };
    // As offered, nothing changes, and the value is the same object.
    expect(pruneEvidence(chosen, SIDES)).toBe(chosen);
    // After a reload, d2 has lost its link to ent-a and d3 its link to ent-b.
    const reloaded: EvidenceSide[] = [
      { ...SIDES[0], descriptions: [SIDES[0].descriptions[0]] },
      { ...SIDES[1], descriptions: [] },
    ];
    const pruned = pruneEvidence(chosen, reloaded);
    expect(pruned).toEqual({ facts: ["dates"], cited: { "ent-a": ["d1"], "ent-b": [] } });
    expect(evidenceReady(pruned, reloaded)).toBe(false);
    expect(evidenceFormEntries(pruned)).toEqual([["evidence_fact", "dates"], ["evidence_description", "ent-a:d1"]]);
    // A citation for a record no longer shown goes too.
    expect(pruneEvidence({ facts: [], cited: { "ent-x": ["d9"] } }, SIDES)).toEqual({ facts: [], cited: {} });
  });

  it("words the facts heading and the no-fact refusal by what the records are, as the pair page asks", async () => {
    expect(evidenceShape("person", "person")).toBe("person");
    expect(evidenceShape("family", "family")).toBe("family");
    expect(evidenceShape("corporate", "corporate")).toBe("corporate");
    expect(evidenceShape("person", "family")).toBe("generic");
    expect(evidenceShape(null, null)).toBe("generic");
    const heading = async (shape: "person" | "family" | "corporate" | "generic", lang: "en" | "es") =>
      render(React.createElement(MergeEvidencePanel, { sides: SIDES, shape, value: { facts: [], cited: {} }, onChange: noop }), lang);
    expect(await heading("person", "en")).toContain("What shows they are the same person?");
    expect(await heading("family", "en")).toContain("What shows they are the same family?");
    expect(await heading("corporate", "en")).toContain("What shows they are the same corporate body?");
    expect(await heading("generic", "en")).toContain("What shows they are the same record?");
    expect(await heading("person", "es")).toContain("¿Qué muestra que son la misma persona?");
    expect(await heading("family", "es")).toContain("¿Qué muestra que son la misma familia?");
    expect(await heading("corporate", "es")).toContain("¿Qué muestra que son la misma entidad corporativa?");
    expect(await heading("generic", "es")).toContain("¿Qué muestra que son el mismo registro?");

    const en = await makeI18n("en");
    const es = await makeI18n("es");
    expect(en.t(evidenceErrorKey("evidence_facts", "person"), { ns: "authorities" }))
      .toBe("Tick at least one fact that shows they are the same person. A name alone is not enough.");
    expect(es.t(evidenceErrorKey("evidence_facts", "corporate"), { ns: "authorities" }))
      .toBe("Marca al menos un hecho que muestre que son la misma entidad corporativa. Un nombre por sí solo no basta.");
    expect(es.t(evidenceErrorKey("evidence_facts"), { ns: "authorities" })).toContain("el mismo registro");
    // The other refusals do not depend on what the records are.
    expect(evidenceErrorKey("evidence_stale", "family")).toBe("merge_evidence.error.evidence_stale");
  });

  it("place pair dialog shows no evidence panel", async () => {
    const html = await render(
      React.createElement(PairMergeDialog, {
        title: "Merge",
        options: [{ code: "nl-a", loadLine: "2" }, { code: "nl-b", loadLine: "1" }],
        defaultSurvivorCode: "nl-a",
        reasonPlaceholder: "",
        onCancel: noop,
        onConfirm: noop,
      }),
    );
    expect(html).not.toContain("merge-evidence-panel");
    expect(html).toContain("Reason (optional)");
    // The survivor is chosen, and a place merge needs nothing else.
    expect(html).toMatch(/<button type="button" class="[^"]*bg-madder[^"]*">Merge records<\/button>/);
  });
});

describe("the duplicates card's chips", () => {
  const side = (id: string, dates: string | null) => ({
    id, name: "Domingo Caicedo", code: `ne-${id}`, entityType: "person", provenance: null, descriptionCount: 1, dates,
  });

  async function page(signals: string[], lang: "en" | "es" = "en") {
    return render(
      React.createElement(DecisionDuplicatesPage as any, {
        loaderData: {
          kind: "entities",
          status: "open",
          pairs: [{ key: "a|b", a: side("a", "1790–1840"), b: side("b", "1800–1835"), signals, comments: [] }],
          ruled: [],
          totalPairs: 1,
          truncated: false,
        },
        params: {},
        matches: [],
      }),
      lang,
    );
  }

  it("card shows the overlapping-dates chip with both spans", async () => {
    const html = await page(["name", "dates", "externalId"]);
    expect(html).toContain("Same name");
    expect(html).toContain("Overlapping dates: 1790–1840 · 1800–1835");
    expect(html).toContain("Shared external id");
    expect(html).toContain('aria-label="Found by the scan"');
    const es = await page(["nearName", "dates"], "es");
    expect(es).toContain("Escritura parecida");
    expect(es).toContain("Fechas que se superponen: 1790–1840 · 1800–1835");
  });

  it("an open dialog reads its pair from the loader's current data and its descriptions from the evidence route", () => {
    const desc = (id: string) => ({ id, code: `co-${id}`, date: null, title: id });
    const opened = { key: "a|b", a: side("a", null), b: side("b", null), signals: ["name"], comments: [] } as unknown as PairView;
    // After a refusal, b is a family in the reloaded queue.
    const reloaded = { ...opened, b: { ...opened.b, entityType: "family" } } as PairView;
    const other = { ...opened, key: "c|d", a: side("c", null), b: side("d", null) } as unknown as PairView;
    const current = currentPair([other, reloaded], opened);
    expect(current).toBe(reloaded);
    expect(evidenceShape(current.a.entityType, current.b.entityType)).toBe("generic");
    // A pair that has left the queue keeps the snapshot taken as the dialog opened.
    expect(currentPair([other], opened)).toBe(opened);

    // No answer yet, or another pair's: the dialog shows its loading line.
    expect(evidenceSidesFor(current, undefined)).toBeNull();
    expect(evidenceSidesFor(current, { a: "c", b: "d", descriptions: {} })).toBeNull();
    expect(evidencePath(current)).toBe("/admin/decisions/evidence?a=a&b=b");
    // The answer for this pair, in either order. Reloaded after the refusal, a no longer holds d1 and holds d3.
    const first = evidenceSidesFor(current, { a: "a", b: "b", descriptions: { a: [desc("d1")], b: [desc("d2")] } })!;
    const again = evidenceSidesFor(current, { a: "b", b: "a", descriptions: { a: [desc("d3")], b: [desc("d2")] } })!;
    expect(first.map((x) => x.descriptions.map((d) => d.id))).toEqual([["d1"], ["d2"]]);
    expect(again[0].descriptions.map((d) => d.id)).toEqual(["d3"]);
    // d1 is dropped from the citations, and d3 is offered.
    expect(pruneEvidence({ facts: ["dates"], cited: { a: ["d1"], b: ["d2"] } }, again)).toEqual({ facts: ["dates"], cited: { a: [], b: ["d2"] } });
  });

  it("loads a pair's descriptions whenever its own fetcher does not hold them and is not loading them", () => {
    const pairA = { key: "a|b", a: side("a", null), b: side("b", null), signals: [], comments: [] } as unknown as PairView;
    const answerA = { a: "a", b: "b", descriptions: {} };
    const answerC = { a: "c", b: "d", descriptions: {} };
    // Nothing open: nothing to load.
    expect(evidenceToLoad(null, undefined, "idle")).toBeNull();
    // Opened for the first time, or reopened after another pair's answer: load.
    expect(evidenceToLoad(pairA, undefined, "idle")).toBe("/admin/decisions/evidence?a=a&b=b");
    expect(evidenceToLoad(pairA, answerC, "idle")).toBe("/admin/decisions/evidence?a=a&b=b");
    // A load of its own in flight, or its answer held: wait, or show it.
    expect(evidenceToLoad(pairA, undefined, "loading")).toBeNull();
    expect(evidenceToLoad(pairA, answerA, "idle")).toBeNull();
    // The route says the pair has gone (after its merge): no reload, no sides, and the dialog closes.
    const goneA = { a: "a", b: "b", gone: true as const };
    expect(evidenceToLoad(pairA, goneA, "idle")).toBeNull();
    expect(evidenceSidesFor(pairA, goneA)).toBeNull();
    expect(evidenceGone(pairA, goneA)).toBe(true);
    expect(evidenceGone(pairA, answerA)).toBe(false);
    expect(evidenceGone(pairA, { a: "c", b: "d", gone: true })).toBe(false);
    expect(evidenceGone(null, goneA)).toBe(false);
  });

  it("the dialog says the descriptions are loading until they arrive, and Merge stays disabled", async () => {
    const html = await render(
      React.createElement(PairMergeDialog, {
        title: "Merge",
        options: [{ code: "ne-a", loadLine: "2" }, { code: "ne-b", loadLine: "1" }],
        defaultSurvivorCode: "ne-a",
        reasonPlaceholder: "",
        evidence: { sides: [{ ...SIDES[0], descriptions: [] }, { ...SIDES[1], descriptions: [] }], loading: true },
        onCancel: noop,
        onConfirm: noop,
      }),
    );
    expect(html.match(/Loading the descriptions…/g)).toHaveLength(2);
    expect(html).not.toContain("there is nothing to cite");
    expect(html).toMatch(/<button type="button" disabled="" class="[^"]*bg-madder[^"]*">Merge records<\/button>/);
    const es = await render(
      React.createElement(MergeEvidencePanel, { sides: SIDES, loading: true, value: { facts: [], cited: {} }, onChange: noop }), "es",
    );
    expect(es).toContain("Cargando las descripciones…");
  });

  it("shows no chips for a pair without signals", async () => {
    expect(await page([])).not.toContain("Found by the scan");
  });
});

// @version v0.9.0
