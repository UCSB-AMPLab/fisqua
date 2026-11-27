/**
 * Tests — publish progress step list
 *
 * This suite pins the step list of the publish page's progress panel.
 * The panel lists every step the run will mark complete as soon as the
 * run is known, grouped by artefact in the order the workflow runs
 * them, and gives each step one of four states: completed, running,
 * pending or failed.
 *
 * Each step row carries `data-step` (the plan step id) and
 * `data-state`, and each artefact group `data-group` and
 * `data-group-state`, which the assertions read from the markup.
 * Rendering mirrors `tests/imports/run-detail-step-label.test.tsx`:
 * When the run's total is the plan's without the authorities capability,
 * the panel leaves out entities, places and their link files even when
 * they are selected, as the workflow does.
 *
 * A completed step shows its duration, and a completed group its total
 * time, from the run's step log (`export_runs.step_log`); a run without
 * one (any run before migration 0117) shows no durations.
 *
 * A run whose current step, record counts or step log name a METS
 * step was written by the code that ran METS steps, and the panel lists
 * it against that plan (`planLegacyPublishSteps`): one part-way through
 * its METS batches, a finished one, and one that failed in a METS
 * batch. A run of that code that has not reached its METS steps names
 * none, and is listed against the current plan, chosen by length as
 * for any run. Plans are never told apart by length alone: a run of two
 * fonds with descriptions and entities has eleven steps both in the
 * current plan with the authorities capability and in the METS plan
 * without it, and only a METS name selects the latter.
 *
 * `renderToStaticMarkup` with an isolated i18next instance loaded with
 * the real locale bundles, inside `createRoutesStub` for the router
 * context `useFormatters` reads.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub } from "react-router";
import enPublish from "../../app/locales/en/publish";
import enCommon from "../../app/locales/en/common";
import esPublish from "../../app/locales/es/publish";
import esCommon from "../../app/locales/es/common";
import { ExportProgressView } from "../../app/components/publish/export-progress";
import { planPublishSteps } from "../../app/lib/export/publish-steps";

const FONDS = ["co-a", "co-b"];
const TYPES = ["descriptions", "repositories", "entities", "places"];
const PLAN_IDS = planPublishSteps({
  selectedFonds: FONDS,
  selectedTypes: TYPES,
  authoritiesEnabled: true,
}).map((s) => s.id);
const NOW = Date.parse("2026-11-01T12:00:00Z");

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: "running",
    selectedFonds: JSON.stringify(FONDS),
    selectedTypes: JSON.stringify(TYPES),
    currentStep: null,
    stepsCompleted: 0,
    totalSteps: PLAN_IDS.length,
    recordCounts: null,
    errorMessage: null,
    completedAt: null,
    startedAt: NOW - 90_000,
    currentStepStartedAt: null,
    currentStepCompletedAt: null,
    lastHeartbeatAt: NOW - 1000,
    stepLog: null,
    ...overrides,
  };
}

async function render(run: Record<string, unknown>, lang: "en" | "es" = "en"): Promise<string> {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: lang,
    fallbackLng: "es",
    defaultNS: "common",
    resources: {
      en: { publish: enPublish, common: enCommon },
      es: { publish: esPublish, common: esCommon },
    },
    interpolation: { escapeValue: false },
  });
  const Stub = createRoutesStub([
    {
      path: "/admin/publish",
      Component: () => React.createElement(ExportProgressView, { data: run as never, now: NOW }),
    },
  ]);
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: inst },
      React.createElement(Stub, { initialEntries: ["/admin/publish"] }),
    ),
  );
}

/** Every step row as [plan step id, state], in document order. */
function rows(html: string): Array<[string, string]> {
  return [...html.matchAll(/data-step="([^"]+)" data-state="([^"]+)"/g)].map((m) => [m[1], m[2]]);
}

function stateOf(html: string, id: string): string | undefined {
  return rows(html).find(([step]) => step === id)?.[1];
}

/** The markup of one step row, up to the next row or the group's end. */
function rowHtml(html: string, id: string): string {
  const start = html.indexOf(`data-step="${id}"`);
  if (start === -1) throw new Error(`no step ${id}`);
  const rest = html.slice(start + 1);
  const end = rest.search(/data-step="|<\/details>|<\/ol>/);
  return rest.slice(0, end === -1 ? undefined : end);
}

/** The markup of a group's summary line. */
function summaryHtml(html: string, group: string): string {
  const start = html.indexOf(`data-group="${group}"`);
  return html.slice(start, html.indexOf("</summary>", start));
}

/** The opening tag of an artefact group's element. */
function groupTag(html: string, group: string): string {
  const m = new RegExp(`<[^>]*data-group="${group}"[^>]*>`).exec(html);
  if (!m) throw new Error(`no group ${group}`);
  return m[0];
}

describe("progress step list - the plan", () => {
  it("lists every step as pending before any step has started", async () => {
    const html = await render(makeRun());
    expect(rows(html)).toEqual(PLAN_IDS.map((id) => [id, "pending"]));
  });

  it("groups the steps by artefact, in the workflow's order", async () => {
    const html = await render(makeRun());
    const groups = [...html.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1]);
    expect(groups).toEqual([
      "descriptions", "index", "children", "ead", "dc",
      "repositories", "entities", "places", "entity_links", "place_links",
    ]);
    expect(html).not.toContain("METS");
    expect(html).toContain("Entity links file");
  });

  it("no longer renders a pill per completed step", async () => {
    const html = await render(makeRun({
      currentStep: "children:co-a",
      currentStepStartedAt: NOW - 5000,
      recordCounts: JSON.stringify({ "descriptions:co-a": 45341 }),
    }));
    expect(html).not.toContain("Descriptions: co-a");
    expect(html).not.toContain("rounded bg-stone-100");
  });
});

describe("progress step list - step states", () => {
  it("ticks the steps before the current one, marks it running and the rest pending", async () => {
    const html = await render(makeRun({
      currentStep: "ead:co-b",
      currentStepStartedAt: NOW - 65_000,
      stepsCompleted: 6,
      recordCounts: JSON.stringify({ "descriptions:co-a": 45341, "descriptions:co-b": 12, "children:co-a": 3 }),
    }));
    const states = rows(html);
    const at = PLAN_IDS.indexOf("ead:co-b");
    expect(states.slice(0, at).every(([, s]) => s === "completed")).toBe(true);
    expect(states[at]).toEqual(["ead:co-b", "running"]);
    expect(states.slice(at + 1).every(([, s]) => s === "pending")).toBe(true);
    // A completed step carries what it wrote; the running one its time.
    expect(html).toContain("45,341 records");
    expect(html).toContain("3 files");
    expect(html).toContain("1m 5s");
  });

  it("collapses a completed group with its count and keeps the running group open", async () => {
    const html = await render(makeRun({ currentStep: "ead:co-b", currentStepStartedAt: NOW - 1000 }));
    expect(groupTag(html, "descriptions")).toContain('data-group-state="completed"');
    expect(groupTag(html, "descriptions")).not.toContain("open");
    expect(groupTag(html, "ead")).toContain('data-group-state="running"');
    expect(groupTag(html, "ead")).toContain("open");
    expect(html).toContain("2 of 2");
    expect(html).toContain("1 of 2");
  });

  it("ticks the current step once it has completed", async () => {
    const html = await render(makeRun({
      currentStep: "ead:co-b",
      currentStepStartedAt: NOW - 3000,
      currentStepCompletedAt: NOW - 1000,
    }));
    expect(stateOf(html, "ead:co-b")).toBe("completed");
    expect(stateOf(html, "dc:co-a")).toBe("pending");
  });

  it("marks the step the run failed in", async () => {
    const html = await render(makeRun({
      status: "error",
      errorMessage: "boom",
      currentStep: "children:co-b",
      currentStepStartedAt: NOW - 3000,
    }));
    expect(stateOf(html, "children:co-a")).toBe("completed");
    expect(stateOf(html, "children:co-b")).toBe("failed");
    expect(stateOf(html, "ead:co-a")).toBe("pending");
    expect(groupTag(html, "children")).toContain('data-group-state="failed"');
    expect(groupTag(html, "children")).toContain("open");
  });

  it("marks the next step failed when the run failed after its current step completed", async () => {
    const html = await render(makeRun({
      status: "error",
      currentStep: "children:co-b",
      currentStepStartedAt: NOW - 3000,
      currentStepCompletedAt: NOW - 2000,
    }));
    expect(stateOf(html, "children:co-b")).toBe("completed");
    expect(stateOf(html, "ead:co-a")).toBe("failed");
  });

  it("ticks every step of a complete run", async () => {
    const html = await render(makeRun({
      status: "complete",
      currentStep: "place_links:3",
      stepsCompleted: PLAN_IDS.length,
      completedAt: NOW,
    }));
    expect(rows(html).every(([, s]) => s === "completed")).toBe(true);
    expect(rows(html)).toHaveLength(PLAN_IDS.length);
  });
});

describe("progress step list - Spanish", () => {
  it("gives a group's count in Spanish", async () => {
    const html = await render(makeRun({ currentStep: "children:co-b", currentStepStartedAt: NOW - 2000 }), "es");
    expect(html).toContain("1 de 2");
  });
});

describe("progress step list - a run created with METS steps", () => {
  // The earlier plan for this run, as it was counted.
  const LEGACY_IDS = [
    "descriptions:co-a", "descriptions:co-b", "descriptions:index",
    "children:co-a", "children:co-b", "mets:co-a", "mets:co-b",
    "ead:co-a", "ead:co-b", "dc:co-a", "dc:co-b",
    "repositories", "entities", "places", "entity_links", "place_links",
  ];
  const legacyRun = (overrides: Record<string, unknown>) =>
    makeRun({ totalSteps: LEGACY_IDS.length, ...overrides });

  it("lists a run that has not reached its METS steps against the current plan", async () => {
    // No METS name yet, so nothing marks the run as one of the earlier
    // code's. Its total matches no current plan with the capability, so
    // it is listed as main lists such a run, without it.
    const html = await render(legacyRun({ currentStep: "descriptions:co-b", currentStepStartedAt: NOW - 2000, stepsCompleted: 1 }));
    const current = planPublishSteps({ selectedFonds: FONDS, selectedTypes: TYPES, authoritiesEnabled: false }).map((s) => s.id);
    expect(rows(html).map(([id]) => id)).toEqual(current);
    expect(stateOf(html, "descriptions:co-b")).toBe("running");
    expect(html).not.toContain('data-group="mets"');
  });

  it("shows the steps completed and the METS step running part-way through its METS batches", async () => {
    const html = await render(legacyRun({
      currentStep: "mets:co-b:2",
      currentStepStartedAt: NOW - 2000,
      stepsCompleted: 6,
      recordCounts: JSON.stringify({ "mets:co-a": 3 }),
    }));
    const states = rows(html);
    const at = LEGACY_IDS.indexOf("mets:co-b");
    expect(states.slice(0, at).every(([, st]) => st === "completed")).toBe(true);
    expect(states[at]).toEqual(["mets:co-b", "running"]);
    expect(states.slice(at + 1).every(([, st]) => st === "pending")).toBe(true);
    expect(rowHtml(html, "mets:co-a")).toContain("3 files");
    expect(html).toContain("METS XML");
  });

  it("ticks every step of a finished run", async () => {
    const html = await render(legacyRun({
      status: "complete",
      currentStep: "place_links:3",
      stepsCompleted: LEGACY_IDS.length,
      completedAt: NOW,
      recordCounts: JSON.stringify({ "mets:co-a": 3, "mets:co-b": 1 }),
    }));
    expect(rows(html)).toEqual(LEGACY_IDS.map((id) => [id, "completed"]));
  });

  it("marks the METS step a run failed in", async () => {
    const html = await render(legacyRun({
      status: "error",
      errorMessage: "boom",
      currentStep: "mets:co-a:1",
      currentStepStartedAt: NOW - 2000,
      stepsCompleted: 5,
    }));
    expect(stateOf(html, "children:co-b")).toBe("completed");
    expect(stateOf(html, "mets:co-a")).toBe("failed");
    expect(stateOf(html, "mets:co-b")).toBe("pending");
  });

  describe("with a total both plans share", () => {
    // Two fonds, descriptions and entities: eleven steps in the current
    // plan with the capability and in the METS plan without it.
    const types = ["descriptions", "entities"];
    const shared = (overrides: Record<string, unknown>) =>
      makeRun({ selectedTypes: JSON.stringify(types), totalSteps: 11, ...overrides });

    it("lists a run with no METS name against the current plan", async () => {
      const html = await render(shared({ currentStep: "ead:co-a", currentStepStartedAt: NOW - 1000 }));
      const current = planPublishSteps({ selectedFonds: FONDS, selectedTypes: types, authoritiesEnabled: true }).map((s) => s.id);
      expect(current).toHaveLength(11);
      expect(rows(html).map(([id]) => id)).toEqual(current);
    });

    it("lists a run whose step log names a METS step against the METS plan", async () => {
      const html = await render(shared({
        currentStep: "ead:co-a",
        currentStepStartedAt: NOW - 1000,
        stepLog: JSON.stringify({ "mets:co-a": { startedAt: NOW - 5000, completedAt: NOW - 4000 } }),
      }));
      expect(rows(html).map(([id]) => id)).toEqual([
        "descriptions:co-a", "descriptions:co-b", "descriptions:index",
        "children:co-a", "children:co-b", "mets:co-a", "mets:co-b",
        "ead:co-a", "ead:co-b", "dc:co-a", "dc:co-b",
      ]);
    });
  });
});

describe("progress step list - a tenant without the authorities capability", () => {
  // The run row does not record the capability; its total_steps was
  // counted without it, so entities, places and their link files are
  // not in the run's plan even though they are selected.
  const withoutAuthorities = planPublishSteps({
    selectedFonds: FONDS,
    selectedTypes: TYPES,
    authoritiesEnabled: false,
  }).map((s) => s.id);

  it("lists only the steps the run takes, with their states", async () => {
    expect(withoutAuthorities.length).toBeLessThan(PLAN_IDS.length);
    const html = await render(makeRun({
      totalSteps: withoutAuthorities.length,
      currentStep: "repositories",
      currentStepStartedAt: NOW - 2000,
      stepsCompleted: withoutAuthorities.length - 1,
    }));
    const groups = [...html.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1]);
    expect(groups).toEqual(["descriptions", "index", "children", "ead", "dc", "repositories"]);
    for (const absent of ["entities", "places", "entity_links", "place_links"]) {
      expect(html).not.toContain(`data-step="${absent}"`);
    }
    expect(html).not.toContain("Entity links file");
    expect(rows(html)).toEqual(
      withoutAuthorities.map((id) => [id, id === "repositories" ? "running" : "completed"]),
    );
  });
});

describe("progress step list - durations", () => {
  const T0 = NOW - 100_000;
  const log = {
    "descriptions:co-a": { startedAt: T0, completedAt: T0 + 65_000 },
    "descriptions:co-b": { startedAt: T0 + 65_000, completedAt: T0 + 72_000 },
    "descriptions:index": { startedAt: T0 + 72_000, completedAt: T0 + 75_000 },
    "children:co-a": { startedAt: T0 + 75_000 },
  };

  it("shows each completed step's duration from the step log", async () => {
    const html = await render(makeRun({
      currentStep: "children:co-a",
      currentStepStartedAt: T0 + 75_000,
      recordCounts: JSON.stringify({ "descriptions:co-a": 45341 }),
      stepLog: JSON.stringify(log),
    }));
    expect(rowHtml(html, "descriptions:co-a")).toContain("45,341 records");
    expect(rowHtml(html, "descriptions:co-a")).toContain("1m 5s");
    expect(rowHtml(html, "descriptions:co-b")).toContain("0m 7s");
    expect(rowHtml(html, "descriptions:index")).toContain("0m 3s");
  });

  it("shows a completed group's total time, from its first start to its last end", async () => {
    const html = await render(makeRun({
      currentStep: "children:co-a",
      currentStepStartedAt: T0 + 75_000,
      stepLog: JSON.stringify(log),
    }));
    expect(summaryHtml(html, "descriptions")).toContain("1m 12s");
    // A group still running has no total.
    expect(summaryHtml(html, "children")).not.toMatch(/\d+m \d+s/);
  });

  it("shows no durations for a run without a step log", async () => {
    const html = await render(makeRun({
      status: "complete",
      currentStep: "place_links:3",
      stepsCompleted: PLAN_IDS.length,
      completedAt: NOW,
      recordCounts: JSON.stringify({ "descriptions:co-a": 45341 }),
      stepLog: null,
    }));
    expect(rows(html).every(([, s]) => s === "completed")).toBe(true);
    expect(html).toContain("45,341 records");
    expect(html).not.toMatch(/\d+m \d+s/);
  });
});

// @version v0.9.0
