/**
 * Tests — publish step plan
 *
 * This suite pins `planPublishSteps`, the ordered list of the steps a
 * publish run marks complete, which both `PublishExportWorkflow` and
 * the publish page's progress panel read. Three things are checked.
 *
 * The plan's order and ids, written out literally for a run of two
 * fonds and every data type: descriptions per fonds, the descriptions
 * index, children, EAD3 and Dublin Core per fonds, then
 * repositories, entities, places and the two link files. Entities,
 * places and their link files drop out without the authorities
 * capability, and `countPublishSteps` is the plan's length: four steps
 * per fonds and the index when descriptions are selected.
 *
 * `planStepIdOf`, which maps a workflow step name to its plan step:
 * every link-file step (`entity_links:<n>`) to the link file, every
 * METS batch of a run created with the earlier plan
 * (`mets:<fonds>:<n>`) to `mets:<fonds>`, and every other name to
 * itself. `planLegacyPublishSteps` is that earlier plan: the current
 * one with a METS step per fonds between children and EAD3.
 *
 * And the workflow itself: its `run` is driven with a stand-in for the
 * Workflow step that records each step name and runs the step's body,
 * with every exporter replaced by a spy (`vi.mock`). The names, mapped
 * through `planStepIdOf` with consecutive repeats folded, must be the
 * plan; `load-config`, `institution`, `finalize` and the fonds'
 * own-manifest steps (`manifests:{fonds}:{n}`) are not plan steps,
 * and `institution` runs once, last before `finalize`, for the publish
 * tenant. Each step must call its own exporter with its own scope: a
 * per-fonds step its fonds and the fonds' owning tenant, a per-type
 * step and each link file the publish tenant and every member tenant.
 * Each link file takes three batches, and each batch after the first
 * must receive the state the batch before it returned, or the file
 * would be started over. No step is a METS step, and the workflow never
 * reads a METS bucket from its environment.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "../helpers/db";
import { PublishExportWorkflow } from "../../app/workflows/publish-export";
import {
  planPublishSteps,
  planLegacyPublishSteps,
  planStepIdOf,
  countPublishSteps,
} from "../../app/lib/export/publish-steps";

/**
 * Spies for every exporter the workflow calls. Each records the step
 * it ran in and its arguments. A link file takes three batches,
 * counted per exporter, never read from
 * the state passed in, so a run that dropped the state between
 * batches still ends; each batch returns a state carrying a token that
 * names it.
 */
const spies = vi.hoisted(() => {
  const calls: Array<{ fn: string; step: string; args: unknown[] }> = [];
  const batches = new Map<string, number>();
  const self = {
    calls,
    batches,
    step: "",
    spy(fn: string, result: (...args: unknown[]) => unknown) {
      return async (...args: unknown[]) => {
        calls.push({ fn, step: self.step, args });
        return result(...args);
      };
    },
    batch(key: string, token: string, extra: Record<string, unknown>) {
      const n = batches.get(key) ?? 0;
      batches.set(key, n + 1);
      return { ...extra, done: n === 2, token: `${token}:${n}` };
    },
  };
  return self;
});

vi.mock("../../app/lib/export/pipeline.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  exportFondsDescriptions: spies.spy("exportFondsDescriptions", () => ({ recordCount: 1, byteSize: 2 })),
  exportFondsChildren: spies.spy("exportFondsChildren", () => ({ putCount: 1 })),
  exportFondsEad: spies.spy("exportFondsEad", () => ({ recordCount: 1 })),
  exportFondsDc: spies.spy("exportFondsDc", () => ({ recordCount: 1 })),
  exportRepositories: spies.spy("exportRepositories", () => ({ count: 1 })),
  exportInstitutionFiles: spies.spy("exportInstitutionFiles", () => ({ keys: [] })),
  exportEntities: spies.spy("exportEntities", () => ({ count: 1 })),
  exportPlaces: spies.spy("exportPlaces", () => ({ count: 1 })),
}));
vi.mock("../../app/lib/export/combined.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  writeDescriptionsIndex: spies.spy("writeDescriptionsIndex", () => ({ totalRecordCount: 2 })),
}));
vi.mock("../../app/lib/export/link-files.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  exportEntityLinks: spies.spy("exportEntityLinks", () => spies.batch("entity_links", "entity", { count: 1 })),
  exportPlaceLinks: spies.spy("exportPlaceLinks", () => spies.batch("place_links", "place", { count: 1 })),
  abandonLinkExports: spies.spy("abandonLinkExports", () => undefined),
}));

const ALL_TYPES = ["descriptions", "repositories", "entities", "places"];

describe("planPublishSteps", () => {
  it("lists every step in the order the workflow runs them", () => {
    const plan = planPublishSteps({
      selectedFonds: ["co-a", "co-b"],
      selectedTypes: ALL_TYPES,
      authoritiesEnabled: true,
    });
    expect(plan.map((s) => s.id)).toEqual([
      "descriptions:co-a",
      "descriptions:co-b",
      "descriptions:index",
      "children:co-a",
      "children:co-b",
      "ead:co-a",
      "ead:co-b",
      "dc:co-a",
      "dc:co-b",
      "repositories",
      "entities",
      "places",
      "entity_links",
      "place_links",
    ]);
    expect(plan.find((s) => s.id === "ead:co-b")).toEqual({
      id: "ead:co-b",
      kind: "ead",
      fonds: "co-b",
    });
    expect(plan.some((s) => (s.kind as string) === "mets")).toBe(false);
    expect(plan.find((s) => s.id === "descriptions:index")?.kind).toBe("index");
  });

  it("leaves out entities, places and their link files without the authorities capability", () => {
    const plan = planPublishSteps({
      selectedFonds: ["co-a"],
      selectedTypes: ALL_TYPES,
      authoritiesEnabled: false,
    });
    expect(plan.map((s) => s.id)).toEqual([
      "descriptions:co-a",
      "descriptions:index",
      "children:co-a",
      "ead:co-a",
      "dc:co-a",
      "repositories",
    ]);
  });

  it("counts four steps per fonds and the index when descriptions are selected", () => {
    for (const fonds of [["co-a"], ["co-a", "co-b", "co-c"]]) {
      expect(countPublishSteps({ selectedFonds: fonds, selectedTypes: ["descriptions"], authoritiesEnabled: true }))
        .toBe(4 * fonds.length + 1);
    }
  });

  it("has a legacy form with a METS step per fonds between children and EAD3", () => {
    for (const authoritiesEnabled of [true, false]) {
      const options = { selectedFonds: ["co-a", "co-b"], selectedTypes: ALL_TYPES, authoritiesEnabled };
      const current = planPublishSteps(options).map((s) => s.id);
      const legacy = planLegacyPublishSteps(options).map((s) => s.id);
      const at = current.indexOf("ead:co-a");
      expect(legacy).toEqual([...current.slice(0, at), "mets:co-a", "mets:co-b", ...current.slice(at)]);
    }
    expect(planLegacyPublishSteps({ selectedFonds: ["co-a"], selectedTypes: ["repositories"], authoritiesEnabled: true }).map((s) => s.id))
      .toEqual(["repositories"]);
  });

  it("is what countPublishSteps counts", () => {
    for (const authoritiesEnabled of [true, false]) {
      for (const selectedTypes of [ALL_TYPES, ["places"], ["descriptions"], ["entities", "repositories"]]) {
        const options = { selectedFonds: ["co-a", "co-b", "co-c"], selectedTypes, authoritiesEnabled };
        expect(countPublishSteps(options)).toBe(planPublishSteps(options).length);
      }
    }
  });
});

describe("planStepIdOf", () => {
  it("maps every METS batch of an earlier run to its fonds' METS step", () => {
    expect(planStepIdOf("mets:pe-bn-cdip:0")).toBe("mets:pe-bn-cdip");
    expect(planStepIdOf("mets:pe-bn-cdip:17")).toBe("mets:pe-bn-cdip");
  });

  it("maps every link-file step to its link file", () => {
    expect(planStepIdOf("entity_links:0")).toBe("entity_links");
    expect(planStepIdOf("place_links:4")).toBe("place_links");
  });

  it("leaves every other step name as it is", () => {
    for (const name of ["descriptions:co-a", "descriptions:index", "children:co-a", "ead:co-a", "dc:co-a", "repositories", "entities", "places"]) {
      expect(planStepIdOf(name)).toBe(name);
    }
  });
});

describe("the workflow runs the plan", () => {
  // The heartbeat writes are real; the run row does not exist, so they
  // change nothing.
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(() => {
    spies.calls.length = 0;
    spies.batches.clear();
  });

  for (const authoritiesEnabled of [true, false]) {
    it(`runs its steps in the plan's order, each with its own exporter (authorities ${authoritiesEnabled ? "on" : "off"})`, async () => {
      const lead = { id: "lead", federationId: "f", slug: "s", descriptiveStandard: "isadg" };
      const ownerA = { id: "a", federationId: "f", slug: "s", descriptiveStandard: "isadg" };
      const ownerB = { id: "b", federationId: "f", slug: "s", descriptiveStandard: "dacs" };
      const config = {
        selectedFonds: ["co-a", "co-b"],
        selectedTypes: ALL_TYPES,
        publishTenant: lead,
        memberTenantIds: ["a", "b"],
        fondsTenants: { "co-a": ownerA, "co-b": ownerB },
        authoritiesEnabled,
      };
      const names: string[] = [];
      // Runs every step's body, as the Workflow does, and keeps its
      // result as JSON, as the Workflow stores it.
      const step = {
        async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
          names.push(name);
          if (name === "load-config") return config;
          const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
          spies.step = name;
          const result = await callback();
          return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        },
      };
      const workflow = Object.create(PublishExportWorkflow.prototype) as PublishExportWorkflow;
      // Records any read of a METS bucket from the environment.
      let metsBucketRead = false;
      const workflowEnv = { ...env } as Record<string, unknown>;
      Object.defineProperty(workflowEnv, "METS_BUCKET", {
        get() {
          metsBucketRead = true;
          return {};
        },
      });
      (workflow as any).env = workflowEnv;
      await workflow.run(
        { payload: { exportId: "plan-order" }, timestamp: new Date(), instanceId: "i" } as any,
        step as any,
      );

      // The steps, folded to plan steps, are the plan.
      const folded: string[] = [];
      for (const name of names) {
        if (name === "load-config" || name === "institution" || name === "finalize") continue;
        if (name.startsWith("manifests:")) continue;
        const id = planStepIdOf(name);
        if (folded[folded.length - 1] !== id) folded.push(id);
      }
      expect(folded).toEqual(planPublishSteps(config).map((s) => s.id));
      expect(names.filter((n) => n.startsWith("mets:"))).toEqual([]);
      expect(metsBucketRead).toBe(false);

      const callsOf = (fn: string) => spies.calls.filter((c) => c.fn === fn);

      // Each per-fonds step calls its own exporter, for its fonds, read
      // from the fonds' owning tenant.
      for (const [fn, kind] of [
        ["exportFondsDescriptions", "descriptions"],
        ["exportFondsChildren", "children"],
        ["exportFondsEad", "ead"],
        ["exportFondsDc", "dc"],
      ] as const) {
        expect(callsOf(fn).map((c) => [c.step, c.args[2], c.args[3]])).toEqual([
          [`${kind}:co-a`, "co-a", ownerA],
          [`${kind}:co-b`, "co-b", ownerB],
        ]);
      }
      expect(callsOf("exportFondsDescriptions").map((c) => c.args[4])).toEqual([["a", "b"], ["a", "b"]]);
      expect(callsOf("writeDescriptionsIndex").map((c) => [c.step, c.args[1], c.args[3]])).toEqual([
        ["descriptions:index", ["co-a", "co-b"], lead],
      ]);

      // The institution step runs once, after the plan and before
      // finalize, for the publish tenant, whatever the types.
      expect(names.slice(-2)).toEqual(["institution", "finalize"]);
      expect(callsOf("exportInstitutionFiles").map((c) => [c.step, c.args[2]])).toEqual([["institution", lead]]);

      // The per-type steps read across every member tenant.
      const perType = authoritiesEnabled
        ? [["exportRepositories", "repositories"], ["exportEntities", "entities"], ["exportPlaces", "places"]]
        : [["exportRepositories", "repositories"]];
      for (const [fn, name] of perType) {
        expect(callsOf(fn).map((c) => [c.step, c.args[2], c.args[3]])).toEqual([[name, lead, ["a", "b"]]]);
      }

      // Each link file's steps call its own exporter, across every member
      // tenant, each batch after the first with the preceding batch's state.
      for (const [fn, file, token] of [
        ["exportEntityLinks", "entity_links", "entity"],
        ["exportPlaceLinks", "place_links", "place"],
      ] as const) {
        const links = callsOf(fn);
        if (!authoritiesEnabled) {
          expect(links).toEqual([]);
          continue;
        }
        expect(links.map((c) => c.step)).toEqual([`${file}:0`, `${file}:1`, `${file}:2`]);
        for (const c of links) {
          expect(c.args[2]).toEqual(lead);
          expect(c.args[3]).toEqual(["a", "b"]);
        }
        expect(links.map((c) => (c.args[4] as any)?.state?.token)).toEqual([undefined, `${token}:0`, `${token}:1`]);
      }
    });
  }
});

// @version v0.9.0
