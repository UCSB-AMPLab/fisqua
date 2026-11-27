/**
 * Tests — the evidence check for entity merges
 *
 * This suite pins `checkMergeEvidence`, the evidence check for entity
 * merges. A merge of two entity records needs the steward to state at
 * least one independent fact (dates, office, kin, place, matter) and at
 * least one description on each side that shows it. `checkMergeEvidence`
 * checks that the evidence was given and that each cited description is
 * one of the acting tenant's, linked to the record of its side; it does
 * not judge whether the evidence is right. The suite pins the refusals in
 * their order, the normalization of facts and cited ids, the reading of
 * the form's repeated fields, and the guard that fails a batch when a
 * cited link has gone since it was read.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  seedTenants,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import {
  MERGE_FACTS,
  checkMergeEvidence,
  evidenceFromForm,
  evidenceStillLinked,
  evidenceStillLinkedGuard,
  loadEvidenceDescriptions,
} from "../../app/lib/merge-evidence.server";

const A = DEFAULT_TEST_TENANT_ID;
const B = SECOND_TEST_TENANT_ID;
const L = "ent-loser";
const S = "ent-survivor";

function db() {
  return drizzle(env.DB, { schema });
}

let dL: string;
let dS: string;
let dBoth: string;
let dOther: string;
let dForeign: string;

async function link(id: string, descriptionId: string, entityId: string) {
  await db().insert(schema.descriptionEntities).values({
    id, descriptionId, entityId, role: "creator", sequence: 0, createdAt: 1,
  });
}

describe("checkMergeEvidence", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    const repoA = await createTestRepository({ tenantId: A, code: "repo-a" });
    const repoB = await createTestRepository({ tenantId: B, code: "repo-b" });
    dL = (await createTestDescription({ tenantId: A, repositoryId: repoA.id, referenceCode: "a-1" })).id;
    dS = (await createTestDescription({ tenantId: A, repositoryId: repoA.id, referenceCode: "a-2" })).id;
    dBoth = (await createTestDescription({ tenantId: A, repositoryId: repoA.id, referenceCode: "a-3" })).id;
    dOther = (await createTestDescription({ tenantId: A, repositoryId: repoA.id, referenceCode: "a-4" })).id;
    dForeign = (await createTestDescription({ tenantId: B, repositoryId: repoB.id, referenceCode: "b-1" })).id;
    await createTestEntity({ id: L, entityCode: "ne-l1" });
    await createTestEntity({ id: S, entityCode: "ne-s1" });
    await createTestEntity({ id: "ent-third", entityCode: "ne-t1" });
    await link("lk-l", dL, L);
    await link("lk-s", dS, S);
    await link("lk-bl", dBoth, L);
    await link("lk-bs", dBoth, S);
    await link("lk-o", dOther, "ent-third");
    await link("lk-fl", dForeign, L);
  });

  const check = (facts: string[], cited: Array<[string, string]>) =>
    checkMergeEvidence(db(), A, L, S, {
      facts,
      cited: cited.map(([entityId, descriptionId]) => ({ entityId, descriptionId })),
    });

  it("accepts dates+matter with one description per side", async () => {
    const result = await check(["matter", "dates"], [[L, dL], [S, dS]]);
    expect(result).toEqual({
      ok: true,
      evidence: { facts: ["dates", "matter"], descriptions: { [L]: [dL], [S]: [dS] } },
    });
  });

  it("orders and deduplicates facts and cited ids", async () => {
    const result = await check(["place", "kin", "place", "dates"], [[L, dL], [L, dL], [S, dS], [L, dBoth]]);
    expect(result).toEqual({
      ok: true,
      evidence: { facts: ["dates", "kin", "place"], descriptions: { [L]: [dL, dBoth], [S]: [dS] } },
    });
    expect([...MERGE_FACTS]).toEqual(["dates", "office", "kin", "place", "matter"]);
  });

  it("refuses no facts (evidence_facts)", async () => {
    expect(await check([], [[L, dL], [S, dS]])).toEqual({ ok: false, error: "evidence_facts" });
  });

  it("refuses an unknown fact (evidence_facts)", async () => {
    expect(await check(["dates", "name"], [[L, dL], [S, dS]])).toEqual({ ok: false, error: "evidence_facts" });
  });

  it("refuses a side with no description (evidence_loser / evidence_survivor)", async () => {
    expect(await check(["dates"], [[S, dS]])).toEqual({ ok: false, error: "evidence_loser" });
    expect(await check(["dates"], [[L, dL]])).toEqual({ ok: false, error: "evidence_survivor" });
    // The facts are checked first.
    expect(await check([], [])).toEqual({ ok: false, error: "evidence_facts" });
  });

  it("refuses a description linked to neither record (evidence_unlinked)", async () => {
    expect(await check(["dates"], [[L, dL], [S, dOther]])).toEqual({ ok: false, error: "evidence_unlinked" });
    // A description of the other side, cited for this one.
    expect(await check(["dates"], [[L, dS], [S, dS]])).toEqual({ ok: false, error: "evidence_unlinked" });
    // An entity that is neither side.
    expect(await check(["dates"], [[L, dL], [S, dS], ["ent-third", dOther]])).toEqual({ ok: false, error: "evidence_unlinked" });
  });

  it("refuses a description of another tenant (evidence_unlinked)", async () => {
    expect(await check(["dates"], [[L, dForeign], [S, dS]])).toEqual({ ok: false, error: "evidence_unlinked" });
  });

  it("allows one description cited for both sides", async () => {
    const result = await check(["matter"], [[L, dBoth], [S, dBoth]]);
    expect(result).toEqual({
      ok: true,
      evidence: { facts: ["matter"], descriptions: { [L]: [dBoth], [S]: [dBoth] } },
    });
  });

  it("evidenceFromForm parses repeated fields", () => {
    const form = new FormData();
    form.append("evidence_fact", "dates");
    form.append("evidence_fact", " matter ");
    form.append("evidence_fact", "");
    form.append("evidence_description", `${L}:${dL}`);
    form.append("evidence_description", `${S}:${dS}`);
    form.append("evidence_description", "no-colon");
    form.append("evidence_description", ":missing-entity");
    expect(evidenceFromForm(form)).toEqual({
      facts: ["dates", "matter"],
      cited: [
        { entityId: L, descriptionId: dL },
        { entityId: S, descriptionId: dS },
      ],
    });
  });

  it("guard fails the batch when a cited link was deleted", async () => {
    const result = await check(["dates"], [[L, dL], [S, dS]]);
    if (!result.ok) throw new Error("expected evidence");
    // As read, the guard passes and the batch writes.
    await db().batch([
      evidenceStillLinkedGuard(db(), A, result.evidence),
      db().update(schema.entities).set({ honorific: "don" }).where(eq(schema.entities.id, S)),
    ] as any);
    expect((await db().select().from(schema.entities).where(eq(schema.entities.id, S)).get())!.honorific).toBe("don");
    expect(await evidenceStillLinked(db(), A, result.evidence)).toBe(true);

    await db().delete(schema.descriptionEntities).where(eq(schema.descriptionEntities.id, "lk-s"));
    await expect(
      db().batch([
        evidenceStillLinkedGuard(db(), A, result.evidence),
        db().update(schema.entities).set({ honorific: "fray" }).where(eq(schema.entities.id, S)),
      ] as any),
    ).rejects.toThrow();
    expect((await db().select().from(schema.entities).where(eq(schema.entities.id, S)).get())!.honorific).toBe("don");
    expect(await evidenceStillLinked(db(), A, result.evidence)).toBe(false);
  });
});

describe("loadEvidenceDescriptions under a D1 overload refusal", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    const repo = await createTestRepository({ tenantId: A, code: "repo-a" });
    dL = (await createTestDescription({ tenantId: A, repositoryId: repo.id, referenceCode: "a-1" })).id;
    await createTestEntity({ id: L, entityCode: "ne-l1" });
    await link("lk-l", dL, L);
  });

  /** The test D1, whose first statement reading the evidence descriptions D1 refuses as overloaded. */
  function refusingOnce(): { DB: D1Database; refusals: () => number } {
    let refusals = 0;
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            const stmt = target.prepare(query);
            if (!/ROW_NUMBER\(\)/.test(query) || refusals > 0) return stmt;
            return new Proxy(stmt, {
              get(s, p) {
                if (p === "bind") {
                  return (...args: unknown[]) => {
                    const bound = s.bind(...args);
                    return new Proxy(bound, {
                      get(b, q) {
                        if (q === "all") {
                          return async () => {
                            refusals += 1;
                            throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
                          };
                        }
                        const v = (b as any)[q];
                        return typeof v === "function" ? v.bind(b) : v;
                      },
                    });
                  };
                }
                const v = (s as any)[p];
                return typeof v === "function" ? v.bind(s) : v;
              },
            });
          };
        }
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { DB, refusals: () => refusals };
  }

  it("reads the descriptions again when D1 refuses the first read as overloaded", async () => {
    const { DB, refusals } = refusingOnce();
    const found = await loadEvidenceDescriptions(drizzle(DB, { schema }), A, [L], { sleep: async () => {} });
    expect(refusals()).toBe(1);
    expect(found[L].map((d) => d.id)).toEqual([dL]);
  });
});

// @version v0.9.0
