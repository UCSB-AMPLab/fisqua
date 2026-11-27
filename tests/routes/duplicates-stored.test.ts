/**
 * Tests — the possible-duplicates page reads the stored pairs
 *
 * This suite pins that the possible-duplicates page reads its entity pairs
 * from `duplicate_candidates`, which the scheduled recheck fills, rather
 * than scanning every entity record on each request. It pins what the
 * loader does with those rows: lists them in weight order, drops the pairs
 * separated or ruled since they were stored, shows only the acting
 * workspace's rows, resolves the names in the facts from the ids at read
 * time, and reads no entity without an id filter. It also covers the
 * sidebar badge's entity count, the places queue that still computes its
 * pairs, and the facts block of the card, rendered with
 * `renderToStaticMarkup`.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, RouterContextProvider } from "react-router";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import authorities from "../../app/locales/en/authorities";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { createTestDescription } from "../helpers/descriptions";
import { createTestRepository } from "../helpers/repositories";
import { tenantContext, userContext } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import type { PairFacts } from "../../app/lib/duplicate-facts";
import { DuplicateFacts } from "../../app/components/admin/duplicate-facts";
import { getDuplicateBadgeCounts } from "../../app/lib/authority-duplicates.server";
import "../../app/routes/_auth.admin.decisions.duplicates";

const FED = DEFAULT_TEST_FEDERATION_ID;

function emptyFacts(over: Partial<PairFacts> = {}): PairFacts {
  return {
    warning: null,
    offices: ["Alcalde ordinario"],
    associates: [],
    documents: [],
    dates: { a: null, b: null, overlap: false },
    places: [],
    more: { associates: 0, documents: 0, places: 0 },
    ...over,
  };
}

async function store(a: string, b: string, weight: number, facts: PairFacts = emptyFacts(), tenantId = DEFAULT_TEST_TENANT_ID) {
  const [x, y] = a < b ? [a, b] : [b, a];
  await env.DB.prepare(
    "INSERT INTO duplicate_candidates (id_a, id_b, federation_id, tenant_id, facts, weight, computed_at) VALUES (?, ?, ?, ?, ?, ?, 1)",
  )
    .bind(x, y, FED, tenantId, JSON.stringify(facts), weight)
    .run();
}

let seq = 0;
const person = (id: string, name = "Juan Pérez") =>
  createTestEntity({ id, displayName: name, sortName: name, entityCode: `ne-st${String(++seq).padStart(4, "0")}` });

function ctx() {
  const c: any = new RouterContextProvider();
  c.set(userContext, makeUserContext({ id: "u-admin", isAdmin: true }));
  c.set(tenantContext, makeTenantContext());
  c.cloudflare = { env };
  return c;
}

async function load(url = "/admin/decisions/duplicates"): Promise<any> {
  const { loader } = await import("../../app/routes/_auth.admin.decisions.duplicates");
  return loader({ request: new Request(`http://neogranadina.fisqua.test${url}`), context: ctx(), params: {} } as any);
}

describe("the entity worklist reads stored pairs", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await createTestUser({ id: "u-admin", isAdmin: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("the entity worklist lists stored pairs in weight order", async () => {
    for (const id of ["e1", "e2", "e3", "e4"]) await person(id);
    await store("e1", "e2", 3);
    await store("e3", "e4", 9);
    await store("e1", "e3", 5);
    const data = await load();
    expect(data.pairs.map((p: any) => p.key)).toEqual(["e3|e4", "e1|e3", "e1|e2"]);
    expect(data.totalPairs).toBe(3);
    expect(data.pairs[0].facts.offices).toEqual(["Alcalde ordinario"]);
  });

  it("a stored pair separated after it was computed is not shown", async () => {
    await person("e1");
    await person("e2");
    await person("e3");
    await store("e1", "e2", 5);
    await store("e1", "e3", 4);
    const user = await createTestUser({ isAdmin: true });
    await drizzle(env.DB).insert(schema.authorityOperations).values({
      id: crypto.randomUUID(),
      federationId: FED,
      recordType: "entity",
      operation: "separate",
      sourceId: "e2",
      targetId: "e1",
      userId: user.id,
      detail: null,
      createdAt: Date.now(),
    });
    const data = await load();
    expect(data.pairs.map((p: any) => p.key)).toEqual(["e1|e3"]);
    expect(data.totalPairs).toBe(1);
  });

  it("a ruled pair is not shown", async () => {
    await person("e1");
    await person("e2");
    await store("e1", "e2", 5);
    const { action } = await import("../../app/routes/_auth.admin.decisions.duplicates");
    const ok: any = await action({
      request: new Request("http://neogranadina.fisqua.test/admin/decisions/duplicates", {
        method: "POST",
        body: new URLSearchParams({ _action: "keepBoth", idA: "e1", idB: "e2", reason: "namesakes" }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      context: ctx(),
      params: {},
    } as any);
    expect(ok).toEqual({ ok: true, ruling: "kept_both" });
    const data = await load();
    expect(data.pairs).toHaveLength(0);
    expect(data.totalPairs).toBe(0);
  });

  it("another workspace's rows are not shown", async () => {
    for (const id of ["e1", "e2", "e3", "e4"]) await person(id);
    await store("e1", "e2", 5);
    await store("e3", "e4", 9, emptyFacts(), SECOND_TEST_TENANT_ID);
    const data = await load();
    expect(data.pairs.map((p: any) => p.key)).toEqual(["e1|e2"]);
    expect(data.totalPairs).toBe(1);
  });

  it("a pair whose record was merged away is skipped and the next one takes its place", async () => {
    await person("e1");
    await person("e2");
    await person("e3");
    await createTestEntity({ id: "e4", displayName: "Gone", sortName: "Gone", entityCode: "ne-gone01", mergedInto: "e1" });
    await store("e1", "e4", 9);
    await store("e2", "e3", 2);
    const data = await load();
    expect(data.pairs.map((p: any) => p.key)).toEqual(["e2|e3"]);
  });

  it("names and titles in the facts are read from the ids, and gone ones are dropped", async () => {
    await person("e1");
    await person("e2");
    await createTestEntity({ id: "a1", displayName: "Renamed Associate", sortName: "x", entityCode: "ne-assoc1" });
    await createTestEntity({ id: "a2", displayName: "Vanished", sortName: "x", entityCode: "ne-assoc2", mergedInto: "a1" });
    await createTestRepository({ id: "repo-test" }).catch(() => undefined);
    await createTestDescription({ id: "d1", title: "Retitled document" });
    await store(
      "e1",
      "e2",
      7,
      emptyFacts({
        associates: [
          { id: "a1", name: "Old name", code: "old" },
          { id: "a2", name: "Vanished", code: null },
          { id: "a3", name: "Never existed", code: null },
        ],
        documents: [
          { id: "d1", title: "Old title" },
          { id: "d9", title: "Deleted" },
        ],
        more: { associates: 2, documents: 0, places: 0 },
      }),
    );
    const data = await load();
    const f: PairFacts = data.pairs[0].facts;
    expect(f.associates).toEqual([{ id: "a1", name: "Renamed Associate", code: "ne-assoc1" }]);
    expect(f.documents).toEqual([{ id: "d1", title: "Retitled document" }]);
    expect(f.more.associates).toBe(2);
  });

  it("places in the facts are read from the ids, and a place the workspace cannot see is dropped", async () => {
    await person("e1");
    await person("e2");
    await createTestPlace({ id: "p1", placeCode: "nl-st1", displayName: "Tunja" });
    await createTestPlace({ id: "p2", placeCode: "nl-st2", displayName: "Secret Hacienda" });
    await env.DB.prepare("UPDATE places SET tenant_id = ? WHERE id = 'p2'").bind(SECOND_TEST_TENANT_ID).run();
    await store(
      "e1",
      "e2",
      7,
      emptyFacts({
        places: [
          { id: "p1", name: "Old name" },
          { id: "p2", name: "Secret Hacienda" },
          { id: "p9", name: "Gone" },
        ],
      }),
    );
    const data = await load();
    const f: PairFacts = data.pairs[0].facts;
    expect(f.places).toEqual([{ id: "p1", name: "Tunja" }]);
    // Nothing the card is rendered from carries the private name.
    expect(JSON.stringify(data)).not.toMatch(/Secret Hacienda/);
  });

  it("the entity loader reads no full entity list", async () => {
    await person("e1");
    await person("e2");
    await store("e1", "e2", 5, emptyFacts({ associates: [{ id: "a1", name: "n", code: null }] }));
    const seen: string[] = [];
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
      seen.push(q);
      return prepare(q);
    });
    await load();
    const reads = seen.filter((q) => /from\s+"?entities"?/i.test(q));
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(q).toMatch(/"id"\s+in\s+\(select value from json_each/i);
  });

  it("the badge counts the workspace's stored pairs", async () => {
    for (const id of ["e1", "e2", "e3", "e4"]) await person(id);
    await store("e1", "e2", 5);
    await store("e3", "e4", 9);
    await store("e1", "e3", 9, emptyFacts(), SECOND_TEST_TENANT_ID);
    const db = drizzle(env.DB);
    const counts = await getDuplicateBadgeCounts(db, FED, DEFAULT_TEST_TENANT_ID);
    expect(counts).toEqual({ entities: 2, places: 0 });
  });

  it("the badge and the list drop a pair together when it is separated or ruled", async () => {
    for (const id of ["e1", "e2", "e3", "e4", "e5", "e6"]) await person(id);
    await store("e1", "e2", 5);
    await store("e3", "e4", 6);
    await store("e5", "e6", 7);
    const db = drizzle(env.DB);
    const badge = async () => (await getDuplicateBadgeCounts(db, FED, DEFAULT_TEST_TENANT_ID)).entities;
    expect(await badge()).toBe(3);
    expect((await load()).totalPairs).toBe(3);

    const user = await createTestUser({ isAdmin: true });
    await db.insert(schema.authorityOperations).values({
      id: crypto.randomUUID(), federationId: FED, recordType: "entity", operation: "separate",
      sourceId: "e2", targetId: "e1", userId: user.id, detail: null, createdAt: Date.now(),
    });
    expect(await badge()).toBe(2);
    expect((await load()).totalPairs).toBe(2);

    const { action } = await import("../../app/routes/_auth.admin.decisions.duplicates");
    await action({
      request: new Request("http://neogranadina.fisqua.test/admin/decisions/duplicates", {
        method: "POST",
        body: new URLSearchParams({ _action: "keepBoth", idA: "e3", idB: "e4", reason: "namesakes" }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      context: ctx(),
      params: {},
    } as any);
    expect(await badge()).toBe(1);
    expect((await load()).totalPairs).toBe(1);
  });

  it("the place worklist still computes its pairs", async () => {
    await createTestPlace({ displayName: "Popayán", placeCode: "nl-pop001" });
    await createTestPlace({ id: crypto.randomUUID(), displayName: "Popayan", placeCode: "nl-pop002" });
    const data = await load("/admin/decisions/duplicates?type=places");
    expect(data.totalPairs).toBe(1);
    expect(data.pairs[0].signals).toContain("name");
    expect(data.pairs[0].facts).toBeUndefined();
  });
});

describe("the card's facts block", () => {
  const i18n = createInstance();
  void i18n.init({ lng: "en", fallbackLng: "en", resources: { en: { authorities } }, interpolation: { escapeValue: false } });
  const render = (facts: PairFacts) =>
    renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(MemoryRouter, null, React.createElement(DuplicateFacts, { facts })),
      ),
    );

  it("the card shows the same-document warning first", () => {
    const html = render(
      emptyFacts({
        warning: "same-document",
        documents: [{ id: "d1", title: "Probanza" }],
        associates: [{ id: "a1", name: "Mosquera", code: "ne-m1" }],
        places: [{ id: "p1", name: "Popayán" }],
        dates: { a: "1816–1829", b: "1757–1838", overlap: true },
      }),
    );
    const order = ["Same document.", "Both hold", "Both appear with", "Both are named in", "1816–1829 · 1757–1838", "Both are linked to"].map((s) => html.indexOf(s));
    expect(order[0]).toBeGreaterThan(-1);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(html).toContain('href="/admin/entities/a1"');
    expect(html).toContain('href="/admin/descriptions/d1"');
  });

  it("each list shows a +N more line", () => {
    const html = render(
      emptyFacts({
        more: { associates: 4, documents: 0, places: 0 },
        associates: [{ id: "a1", name: "A", code: null }],
      }),
    );
    expect(html).toContain("+4 more");
    expect(html).toContain("Associated records");
  });
});

// @version v0.9.0
