/**
 * Tests — possible-duplicates queue + ledger history
 *
 * Covers the deterministic candidate computation (pure helpers and the
 * duplicates tab's loader), the tab's two rulings — keep both and
 * merge — the capability gates on loader AND action, the per-record
 * operation-history loader, the sidebar badge counts, and the
 * show-merged survivor-name join added to the entities list loader.
 * Harness mirrors `authority-workbench.test.ts`: a
 * `RouterContextProvider` carrying userContext + tenantContext with
 * `cloudflare.env` attached; the acting user is a lead-tenant admin
 * (i.e. a federation steward).
 *
 * The two rulings are asserted through their durable trail rather than
 * their return value: keep both must leave a ruled `kept_both` decision
 * row AND a `separate` ledger operation, merge must point the loser at
 * the survivor and rule the same pair `merged`. The reason is optional
 * on both — the card's dialogs say so, and the ruling functions accept
 * null — so the empty-reason rejection the old worklist carried is
 * gone and is asserted gone.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_FEDERATION_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { tenantContext, userContext, type User, type Tenant } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import {
  normaliseName,
  datesOverlap,
  computeDuplicateCandidates,
  isEditDistanceOne,
  pairKey,
} from "../../app/lib/authority-duplicates.server";
import "../../app/routes/_auth.admin.decisions.duplicates";
import "../../app/routes/_auth.admin.entities.$id.history";
import "../../app/routes/_auth.admin.entities";

function buildContext(user: User, tenant?: Tenant): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant ?? makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

function form(fields: Record<string, string>): Request {
  return new Request(
    "http://neogranadina.fisqua.test/admin/entities/duplicates",
    {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  );
}

function get(url: string): Request {
  return new Request(`http://neogranadina.fisqua.test${url}`);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("duplicate candidate computation (pure)", () => {
  it("normaliseName lowercases, strips accents and punctuation, collapses space", () => {
    expect(normaliseName("González, Juan")).toBe("gonzalez juan");
    expect(normaliseName("  Simón   BOLÍVAR ")).toBe("simon bolivar");
    expect(normaliseName("Santafé de Bogotá")).toBe("santafe de bogota");
    expect(normaliseName("O'Higgins")).toBe("o higgins");
  });

  it("datesOverlap detects intersecting year ranges and rejects disjoint/absent ones", () => {
    const r = (dateStart: string | null, dateEnd: string | null) => ({
      id: "x",
      name: "x",
      code: null,
      dateStart,
      dateEnd,
    });
    expect(datesOverlap(r("1780-01-01", "1830-12-31"), r("1800", "1850"))).toBe(true);
    expect(datesOverlap(r("1700", "1750"), r("1800", "1850"))).toBe(false);
    expect(datesOverlap(r(null, null), r("1800", "1850"))).toBe(false);
    // Open-ended range extends to its known bound.
    expect(datesOverlap(r("1780", null), r("1700", "1790"))).toBe(true);
  });

  it("buckets by normalised name, ranks date-overlap pairs first, excludes separate pairs", () => {
    const records = [
      { id: "a", name: "Juan Pérez", code: "1", dateStart: "1800", dateEnd: "1860" },
      { id: "b", name: "Juan Perez", code: "2", dateStart: "1810", dateEnd: "1870" },
      { id: "c", name: "María López", code: "3", dateStart: null, dateEnd: null },
      { id: "d", name: "Maria Lopez", code: "4", dateStart: null, dateEnd: null },
      { id: "e", name: "Unrelated", code: "5" },
    ];
    const { pairs, truncated } = computeDuplicateCandidates(records, new Set());
    expect(pairs).toHaveLength(2);
    expect(truncated).toBe(false);
    // The Pérez pair has the extra date signal, so it ranks first.
    expect(pairs[0].a.id).toBe("a");
    expect(pairs[0].signals).toEqual(["name", "dates"]);
    expect(pairs[1].signals).toEqual(["name"]);

    // A separate dismissal removes the pair durably.
    const dismissed = computeDuplicateCandidates(
      records,
      new Set([pairKey("b", "a")]),
    );
    expect(dismissed.pairs).toHaveLength(1);
    expect(dismissed.pairs[0].a.name).toBe("María López");
  });

  it("attaches the shared-external-id signal", () => {
    const records = [
      { id: "a", name: "Bolívar", code: "1", externalId: "Q8195" },
      { id: "b", name: "Bolivar", code: "2", externalId: "Q8195" },
    ];
    const { pairs } = computeDuplicateCandidates(records, new Set());
    expect(pairs[0].signals).toContain("externalId");
  });

  it("caps pair generation on a degenerate placeholder-name bucket", () => {
    // 1,000 same-name records would emit ~500K pairs uncapped — the
    // Worker OOM scenario. The cap must bound the output AND flag the
    // truncation so the total never masquerades as exact.
    const records = Array.from({ length: 1000 }, (_, i) => ({
      id: `ph-${i}`,
      name: "sin identificar",
      code: String(i),
    }));
    const { pairs, truncated } = computeDuplicateCandidates(records, new Set());
    expect(pairs.length).toBeLessThanOrEqual(10);
    expect(pairs.length).toBeGreaterThan(0);
    expect(truncated).toBe(true);
  });

  it("does not flag truncation on small buckets", () => {
    const records = [
      { id: "a", name: "Pequeño", code: "1" },
      { id: "b", name: "Pequeno", code: "2" },
    ];
    const { truncated } = computeDuplicateCandidates(records, new Set());
    expect(truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Near-spelling signal (SBMAL editdist1 rule)
// ---------------------------------------------------------------------------

describe("near-spelling candidates (pure)", () => {
  it("isEditDistanceOne accepts one substitution/insertion/deletion only", () => {
    expect(isEditDistanceOne("fortuni", "fortuny")).toBe(true); // substitution
    expect(isEditDistanceOne("catala", "catalan")).toBe(true); // insertion
    expect(isEditDistanceOne("catalan", "catala")).toBe(true); // deletion
    // Identical strings are the exact-collision case, not distance 1.
    expect(isEditDistanceOne("perez", "perez")).toBe(false);
    // Two edits, and a length gap above one, both reject.
    expect(isEditDistanceOne("martines", "martinho")).toBe(false);
    expect(isEditDistanceOne("mora", "morales")).toBe(false);
    // Transpositions are Damerau, which the reference rule excludes.
    expect(isEditDistanceOne("peres", "pesre")).toBe(false);
  });

  it("flags the SBMAL spelling variants exact collision misses", () => {
    const records = [
      { id: "f1", name: "Buenaventura Fortuni", code: "1" },
      { id: "f2", name: "Buenaventura Fortuny", code: "2" },
      { id: "c1", name: "Josep Catalá", code: "3" },
      { id: "c2", name: "Josep Catalán", code: "4" },
      { id: "m1", name: "Juan Martines", code: "5" },
      { id: "m2", name: "Juan Martínez", code: "6" },
    ];
    const { pairs, truncated } = computeDuplicateCandidates(records, new Set());
    expect(truncated).toBe(false);
    expect(pairs).toHaveLength(3);
    expect(pairs.every((p) => p.reason === "near-spelling")).toBe(true);
    expect(pairs.every((p) => p.signals[0] === "nearName")).toBe(true);
    // Accent-stripping is what brings Martines/Martínez to distance 1.
    expect(
      pairs.map((p) => pairKey(p.a.id, p.b.id)).sort(),
    ).toEqual([pairKey("c1", "c2"), pairKey("f1", "f2"), pairKey("m1", "m2")].sort());
  });

  it("ranks exact collisions above near spellings and keeps their signals apart", () => {
    const records = [
      { id: "x1", name: "Ana Restrepo", code: "1" },
      { id: "x2", name: "Ana Réstrepo", code: "2" },
      { id: "y1", name: "Ana Restrepa", code: "3" },
    ];
    const { pairs } = computeDuplicateCandidates(records, new Set());
    expect(pairs[0].reason).toBe("exact-name");
    expect(pairs[0].signals).toEqual(["name"]);
    expect(pairs.filter((p) => p.reason === "near-spelling")).toHaveLength(2);
    expect(pairs[1].signals).toEqual(["nearName"]);
  });

  it("carries date and external-id signals onto near-spelling pairs", () => {
    const records = [
      {
        id: "a",
        name: "Fray Juan Fortuni",
        code: "1",
        dateStart: "1780",
        dateEnd: "1830",
        externalId: "Q123",
      },
      {
        id: "b",
        name: "Fray Juan Fortuny",
        code: "2",
        dateStart: "1800",
        dateEnd: "1840",
        externalId: "Q123",
      },
    ];
    const { pairs } = computeDuplicateCandidates(records, new Set());
    expect(pairs).toHaveLength(1);
    expect(pairs[0].signals).toEqual(["nearName", "dates", "externalId"]);
  });

  it("a separate dismissal suppresses a near-spelling pair too", () => {
    const records = [
      { id: "a", name: "Diego Catalá", code: "1" },
      { id: "b", name: "Diego Catalán", code: "2" },
    ];
    const { pairs } = computeDuplicateCandidates(
      records,
      new Set([pairKey("b", "a")]),
    );
    expect(pairs).toHaveLength(0);
  });

  it("guards short keys so two-letter names do not pair", () => {
    // Below the three-character floor every name is one edit from its
    // neighbours; the reference rule guards at the same length.
    const short = computeDuplicateCandidates(
      [
        { id: "a", name: "Li", code: "1" },
        { id: "b", name: "Lo", code: "2" },
      ],
      new Set(),
    );
    expect(short.pairs).toHaveLength(0);
    expect(short.truncated).toBe(false);

    // Three characters is inside the guard and does pair.
    const atFloor = computeDuplicateCandidates(
      [
        { id: "a", name: "Ubá", code: "1" },
        { id: "b", name: "Ubi", code: "2" },
      ],
      new Set(),
    );
    expect(atFloor.pairs).toHaveLength(1);
    expect(atFloor.pairs[0].reason).toBe("near-spelling");
  });

  it("caps the near-spelling pass and flags the truncation", () => {
    // 20 keys that are all one edit from one another would emit 190
    // pairs; the cap bounds the output and the flag keeps the total
    // honest (the UI renders it with a trailing "+").
    const records = "abcdefghijklmnopqrst".split("").map((c, i) => ({
      id: `n-${i}`,
      name: `Sancho${c}`,
      code: String(i),
    }));
    const { pairs, truncated } = computeDuplicateCandidates(records, new Set());
    expect(truncated).toBe(true);
    expect(pairs).toHaveLength(100);
    expect(pairs.every((p) => p.reason === "near-spelling")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Worklist loader + dismissal action
// ---------------------------------------------------------------------------

describe("entities duplicates worklist", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedCollision() {
    const user = await createTestUser({ isAdmin: true, name: "Ada Lovelace" });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const a = await createTestEntity({
      displayName: "Juan Pérez",
      sortName: "Perez, Juan",
      entityCode: "ne-dupa01",
    });
    const b = await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "Juan Perez",
      sortName: "Perez, Juan",
      entityCode: "ne-dupb01",
    });
    return { user, ctxUser, a, b };
  }

  it("loader surfaces accent-normalised collisions and excludes merged-away records", async () => {
    const { ctxUser, a, b } = await seedCollision();
    // A third same-name record already merged away must not appear.
    const survivor = await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "Someone Else",
      sortName: "Else",
      entityCode: "ne-surv02",
    });
    await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "Juan Pérez",
      sortName: "Perez, Juan",
      entityCode: "ne-dupc01",
      mergedInto: survivor.id,
    });

    const { loader } = await import(
      "../../app/routes/_auth.admin.decisions.duplicates"
    );
    const data: any = await loader({
      request: get("/admin/decisions/duplicates"),
      context: buildContext(ctxUser),
      params: {},
    } as any);

    expect(data.totalPairs).toBe(1);
    const ids = [data.pairs[0].a.id, data.pairs[0].b.id].sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("loader excludes pairs dismissed with a separate operation", async () => {
    const { user, ctxUser, a, b } = await seedCollision();
    const db = drizzle(env.DB);
    await db.insert(schema.authorityOperations).values({
      id: crypto.randomUUID(),
      federationId: DEFAULT_TEST_FEDERATION_ID,
      recordType: "entity",
      operation: "separate",
      sourceId: b.id,
      targetId: a.id,
      userId: user.id,
      detail: JSON.stringify({ reason: "namesakes" }),
      createdAt: Date.now(),
    });

    const { loader } = await import(
      "../../app/routes/_auth.admin.decisions.duplicates"
    );
    const data: any = await loader({
      request: get("/admin/decisions/duplicates"),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(data.totalPairs).toBe(0);
  });

  it("keep both rules the pair and writes exactly one separate op", async () => {
    const { ctxUser, a, b } = await seedCollision();
    const { action } = await import(
      "../../app/routes/_auth.admin.decisions.duplicates"
    );
    const db = drizzle(env.DB);

    const ok: any = await action({
      request: form({
        _action: "keepBoth",
        idA: a.id,
        idB: b.id,
        reason: "different people, same name",
      }),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(ok).toEqual({ ok: true, ruling: "kept_both" });

    const ops = await db.select().from(schema.authorityOperations).all();
    expect(ops).toHaveLength(1);
    expect(ops[0].operation).toBe("separate");
    expect(ops[0].sourceId).toBe(a.id);
    expect(ops[0].targetId).toBe(b.id);
    expect(JSON.parse(ops[0].detail as string).reason).toBe(
      "different people, same name",
    );

    // The decision row the surface reads carries the same judgement.
    const decisions = await db.select().from(schema.pendingDecisions).all();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].kind).toBe("duplicate-pair");
    expect(decisions[0].status).toBe("ruled");
    expect(decisions[0].ruling).toBe("kept_both");

    // The pair disappears from the next load.
    const { loader } = await import(
      "../../app/routes/_auth.admin.decisions.duplicates"
    );
    const data: any = await loader({
      request: get("/admin/decisions/duplicates"),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(data.totalPairs).toBe(0);

    // …and reappears, ruled, in the ruled view.
    const ruledView: any = await loader({
      request: get("/admin/decisions/duplicates?status=ruled"),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(ruledView.ruled).toHaveLength(1);
    expect(ruledView.ruled[0].ruling).toBe("kept_both");
    expect(ruledView.ruled[0].names.sort()).toEqual(
      ["Juan Pérez", "Juan Perez"].sort(),
    );
  });

  it("keep both accepts an empty reason", async () => {
    const { ctxUser, a, b } = await seedCollision();
    const { action } = await import(
      "../../app/routes/_auth.admin.decisions.duplicates"
    );
    const db = drizzle(env.DB);

    const ok: any = await action({
      request: form({
        _action: "keepBoth",
        idA: a.id,
        idB: b.id,
        reason: "  ",
      }),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(ok).toEqual({ ok: true, ruling: "kept_both" });

    const ops = await db.select().from(schema.authorityOperations).all();
    expect(ops).toHaveLength(1);
    expect(JSON.parse(ops[0].detail as string).reason).toBeNull();
  });

  it("merge rules the pair merged and points the loser at the survivor", async () => {
    const { ctxUser, a, b } = await seedCollision();
    const { action, loader } = await import(
      "../../app/routes/_auth.admin.decisions.duplicates"
    );
    const db = drizzle(env.DB);

    const ok: any = await action({
      request: form({
        _action: "merge",
        survivorId: a.id,
        loserId: b.id,
        reason: "one man, two spellings",
      }),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(ok).toEqual({ ok: true, ruling: "merged" });

    const loser = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, b.id))
      .get();
    expect(loser?.mergedInto).toBe(a.id);

    const decisions = await db.select().from(schema.pendingDecisions).all();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].ruling).toBe("merged");
    expect(decisions[0].resultId).toBe(a.id);

    const ops = await db.select().from(schema.authorityOperations).all();
    expect(ops).toHaveLength(1);
    expect(ops[0].operation).toBe("merge");

    // The survivor's code is what the ruled view reports.
    const ruledView: any = await loader({
      request: get("/admin/decisions/duplicates?status=ruled"),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(ruledView.ruled).toHaveLength(1);
    expect(ruledView.ruled[0].survivorCode).toBe("ne-dupa01");
  });

  it("a ruling rejects ids that are not live records of this federation", async () => {
    const { ctxUser, a } = await seedCollision();
    const { action } = await import(
      "../../app/routes/_auth.admin.decisions.duplicates"
    );
    const db = drizzle(env.DB);
    const result: any = await action({
      request: form({
        _action: "keepBoth",
        idA: a.id,
        idB: "not-a-real-id",
        reason: "bogus",
      }),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(result).toEqual({ ok: false, code: "generic" });
    // Nothing was written on the way to the refusal.
    expect(
      await db.select().from(schema.authorityOperations).all(),
    ).toHaveLength(0);
    expect(await db.select().from(schema.pendingDecisions).all()).toHaveLength(
      0,
    );
  });

  it("a second ruling on the same pair reports the conflict", async () => {
    const { ctxUser, a, b } = await seedCollision();
    const { action } = await import(
      "../../app/routes/_auth.admin.decisions.duplicates"
    );
    const fields = {
      _action: "keepBoth",
      idA: a.id,
      idB: b.id,
      reason: "namesakes",
    };
    const first: any = await action({
      request: form(fields),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(first).toEqual({ ok: true, ruling: "kept_both" });

    const second: any = await action({
      request: form(fields),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(second).toEqual({ ok: false, code: "conflict" });
  });

  it("loader and action 404 when the authorities capability is off", async () => {
    const { ctxUser, a, b } = await seedCollision();
    const off = makeTenantContext({ authoritiesEnabled: false });
    const { loader, action } = await import(
      "../../app/routes/_auth.admin.decisions.duplicates"
    );
    await expect(
      loader({
        request: get("/admin/decisions/duplicates"),
        context: buildContext(ctxUser, off),
        params: {},
      } as any),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      action({
        request: form({
          _action: "keepBoth",
          idA: a.id,
          idB: b.id,
          reason: "x",
        }),
        context: buildContext(ctxUser, off),
        params: {},
      } as any),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("places duplicates worklist", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("loader surfaces place collisions with their codes; keep both rules them", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const a = await createTestPlace({
      displayName: "Santafé",
      label: "Santafé",
      placeCode: "nl-dupa01",
      tgnId: "7016812",
    });
    const b = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Santafe",
      label: "Santafe",
      placeCode: "nl-dupb01",
      tgnId: "7016812",
    });

    const { loader, action } = await import(
      "../../app/routes/_auth.admin.decisions.duplicates"
    );
    const data: any = await loader({
      request: get("/admin/decisions/duplicates?type=places"),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(data.totalPairs).toBe(1);
    // The card's panes travel with the pair: codes, the place type
    // label's input, and the description load.
    expect(
      [data.pairs[0].a.code, data.pairs[0].b.code].sort(),
    ).toEqual(["nl-dupa01", "nl-dupb01"]);
    expect(data.pairs[0].a.descriptionCount).toBe(0);
    expect(data.pairs[0].a.entityType).toBeNull();

    const ok: any = await action({
      request: form({
        _action: "keepBoth",
        recordKind: "places",
        idA: a.id,
        idB: b.id,
        reason: "city and province",
      }),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(ok).toEqual({ ok: true, ruling: "kept_both" });

    const after: any = await loader({
      request: get("/admin/decisions/duplicates?type=places"),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(after.totalPairs).toBe(0);

    const db = drizzle(env.DB);
    const ops = await db.select().from(schema.authorityOperations).all();
    expect(ops).toHaveLength(1);
    expect(ops[0].recordType).toBe("place");
  });
});

// ---------------------------------------------------------------------------
// Operation history loader
// ---------------------------------------------------------------------------

describe("entity operation history", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns the record's operations in both directions, newest first", async () => {
    const user = await createTestUser({ isAdmin: true, name: "Ada Lovelace" });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const record = await createTestEntity({
      displayName: "Historied",
      sortName: "Historied",
      entityCode: "ne-hist01",
    });
    const other = await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "Counterpart",
      sortName: "Counterpart",
      entityCode: "ne-hist02",
    });
    const db = drizzle(env.DB);
    const base = Date.now();
    // Older: this record was the TARGET of a split (created from other).
    await db.insert(schema.authorityOperations).values({
      id: "op-hist-1",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      recordType: "entity",
      operation: "split",
      sourceId: other.id,
      targetId: record.id,
      userId: user.id,
      detail: JSON.stringify({ reason: "conflation fix", movedLinks: 3 }),
      createdAt: base - 1000,
    });
    // Newer: this record is the SOURCE of a separate.
    await db.insert(schema.authorityOperations).values({
      id: "op-hist-2",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      recordType: "entity",
      operation: "separate",
      sourceId: record.id,
      targetId: other.id,
      userId: user.id,
      detail: JSON.stringify({ reason: "namesakes" }),
      createdAt: base,
    });

    const { loader } = await import(
      "../../app/routes/_auth.admin.entities.$id.history"
    );
    const data: any = await loader({
      request: get(`/admin/entities/${record.id}/history`),
      context: buildContext(ctxUser),
      params: { id: record.id },
    } as any);

    expect(data.history).toHaveLength(2);
    expect(data.history[0].id).toBe("op-hist-2");
    expect(data.history[0].direction).toBe("source");
    expect(data.history[0].reason).toBe("namesakes");
    expect(data.history[1].id).toBe("op-hist-1");
    expect(data.history[1].direction).toBe("target");
    expect(data.history[1].movedLinks).toBe(3);
    expect(data.history[1].userName).toBe("Ada Lovelace");
    expect(data.historyTotal).toBe(2);
    expect(data.counterpartNames[other.id]).toBe("Counterpart");
  });

  it("caps the rendered history at the latest 100 with the true total", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const record = await createTestEntity({
      displayName: "Busy Record",
      sortName: "Busy",
      entityCode: "ne-busy01",
    });
    const other = await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "Counterpart",
      sortName: "Counterpart",
      entityCode: "ne-busy02",
    });
    const db = drizzle(env.DB);
    const base = Date.now();
    // 105 separate ops, inserted in chunks (D1 bound-parameter limit).
    const ops = Array.from({ length: 105 }, (_, i) => ({
      id: `op-busy-${i}`,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      recordType: "entity" as const,
      operation: "separate" as const,
      sourceId: record.id,
      targetId: other.id,
      userId: user.id,
      detail: null,
      createdAt: base + i,
    }));
    for (let i = 0; i < ops.length; i += 10) {
      await db.insert(schema.authorityOperations).values(ops.slice(i, i + 10));
    }

    const { loader } = await import(
      "../../app/routes/_auth.admin.entities.$id.history"
    );
    const data: any = await loader({
      request: get(`/admin/entities/${record.id}/history`),
      context: buildContext(ctxUser),
      params: { id: record.id },
    } as any);
    expect(data.history).toHaveLength(100);
    expect(data.historyTotal).toBe(105);
    // Newest first: the latest op leads.
    expect(data.history[0].id).toBe("op-busy-104");
  });

  it("404s when the authorities capability is off", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const record = await createTestEntity({
      displayName: "Gated",
      sortName: "Gated",
      entityCode: "ne-gate01",
    });
    const { loader } = await import(
      "../../app/routes/_auth.admin.entities.$id.history"
    );
    await expect(
      loader({
        request: get(`/admin/entities/${record.id}/history`),
        context: buildContext(ctxUser, makeTenantContext({ authoritiesEnabled: false })),
        params: { id: record.id },
      } as any),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Sidebar badge counts + show-merged survivor join
// ---------------------------------------------------------------------------

describe("badge counts + survivor-name join", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("getDuplicateBadgeCounts counts exact-name collision pairs and subtracts dismissals", async () => {
    const user = await createTestUser({ isAdmin: true });
    const a = await createTestEntity({
      displayName: "Same Name",
      sortName: "Same",
      entityCode: "ne-bdg001",
    });
    const b = await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "same name",
      sortName: "Same",
      entityCode: "ne-bdg002",
    });
    const db = drizzle(env.DB);
    const { getDuplicateBadgeCounts } = await import(
      "../../app/lib/authority-duplicates.server"
    );

    const before = await getDuplicateBadgeCounts(db, DEFAULT_TEST_FEDERATION_ID);
    expect(before.entities).toBe(1);
    expect(before.places).toBe(0);

    await db.insert(schema.authorityOperations).values({
      id: crypto.randomUUID(),
      federationId: DEFAULT_TEST_FEDERATION_ID,
      recordType: "entity",
      operation: "separate",
      sourceId: a.id,
      targetId: b.id,
      userId: user.id,
      detail: JSON.stringify({ reason: "different" }),
      createdAt: Date.now(),
    });
    const after = await getDuplicateBadgeCounts(db, DEFAULT_TEST_FEDERATION_ID);
    expect(after.entities).toBe(0);
  });

  it("the entities list loader attaches survivor names to merged rows when showMerged is on", async () => {
    await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ isAdmin: true });
    const survivor = await createTestEntity({
      displayName: "The Survivor",
      sortName: "Survivor",
      entityCode: "ne-jsv001",
    });
    await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "Merged Away",
      sortName: "Merged",
      entityCode: "ne-jma001",
      mergedInto: survivor.id,
    });

    const { loader } = await import("../../app/routes/_auth.admin.entities");
    const data: any = await loader({
      request: get("/admin/entities?showMerged=true"),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    const merged = data.entities.find(
      (e: any) => e.displayName === "Merged Away",
    );
    expect(merged).toBeTruthy();
    expect(merged.survivorName).toBe("The Survivor");
  });
});
