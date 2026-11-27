/**
 * Tests — recording zasqua.org's retired codes
 *
 * This suite covers the pure half of the command that appends the codes
 * zasqua.org has published to the `legacy_ids` of the Fisqua records
 * they pair with by Django id. Pairing: an entity or place code lands on
 * the one record holding its Django id, or on the record a merged one
 * was merged into. Idempotence: once the statements' effect is applied,
 * a second plan writes nothing. Refusals: a file record with no pair or
 * two, a code appearing twice, a code equal to a live one, a file that
 * is not a JSON array. Dangling place codes resolve to the single Fisqua
 * place their links point to, and are left alone otherwise. Descriptions
 * gain a former reference code only where the code differs and the entry
 * is not there, including the code of a description another absorbed. No
 * statement ever writes an entity, place or reference code, and a record
 * changed, touched or merged since the read fails the whole file; the
 * provider guards count entries through the JSON, as the planner does,
 * and a code to record that became a live code after the read fails the
 * file too. A dangling code's links are paired with Fisqua's
 * descriptions through the site's own reference codes and Django ids,
 * and with places through merges. The array reader refuses commas that
 * are missing, doubled or trailing. Who writes: the changelog user is
 * resolved, for each workspace a write lands in, as the other nouns of
 * the command line resolve the actor (a shared record's workspace being
 * the federation's lead, where its steward acts); each changelog row
 * records in `acted_as` how they acted there, the file opens with the
 * same guards, and a workspace they may not act in, or shared records
 * of a federation they are no steward of, stop the run.
 *
 * @version v0.9.0
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStatements,
  danglingPlaceCodes,
  duplicateCodes,
  holdingCountSql,
  liveCodeGuards,
  GUARD_STATEMENT_BYTES,
  retiredCodeActing,
  liveCodesByFederation,
  pairSiteReferences,
  placeIdsBySiteCode,
  planAuthorities,
  planDescriptions,
  resolveDangling,
  streamJsonArray,
  type AuthorityRow,
  type DescriptionRow,
  type KindPlan,
} from "../../scripts/lib/retired-codes";

const FED = "fed-1";
const dj = (id: number, extra: object[] = []) => JSON.stringify([{ provider: "django-zasqua", id }, ...extra]);
const ent = (id: string, code: string, djangoId: number, over: Partial<AuthorityRow> = {}): AuthorityRow => ({
  id, federationId: FED, tenantId: null, code, mergedInto: null, legacyIds: dj(djangoId), updatedAt: 500, ...over,
});
const desc = (id: string, referenceCode: string, legacyIds: string): DescriptionRow => ({
  id, tenantId: "t-1", referenceCode, legacyIds, updatedAt: 500,
});

/** An in-memory entities table holding the rows as read. */
function entityDb(rows: AuthorityRow[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE entities (id TEXT PRIMARY KEY, federation_id TEXT, tenant_id TEXT, entity_code TEXT, merged_into TEXT, legacy_ids TEXT, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE places (id TEXT PRIMARY KEY, federation_id TEXT, tenant_id TEXT, place_code TEXT, merged_into TEXT, legacy_ids TEXT, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT, reference_code TEXT, legacy_ids TEXT, updated_at INTEGER NOT NULL, updated_by TEXT);" +
      "CREATE TABLE changelog (id TEXT, record_id TEXT, record_type TEXT, user_id TEXT, note TEXT, diff TEXT, created_at INTEGER, kind TEXT, acted_as TEXT);",
  );
  const insert = db.prepare("INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) insert.run(r.id, r.federationId, r.tenantId, r.code, r.mergedInto, r.legacyIds, r.updatedAt);
  return db;
}

/** Run the statements as one file: all of them, or none. */
function applyAll(db: DatabaseSync, statements: string[]): void {
  db.exec("BEGIN");
  try {
    for (const s of statements) db.prepare(s).all();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const changelogRows = (db: DatabaseSync) => (db.prepare("SELECT count(*) AS n FROM changelog").get() as { n: number }).n;

/** Apply a plan's writes to the rows, as the UPDATEs would. */
function applied<T extends { id: string; legacyIds: string }>(rows: T[], plan: KindPlan): T[] {
  const byId = new Map(plan.writes.map((w) => [w.id, w.newLegacyIds]));
  return rows.map((r) => (byId.has(r.id) ? { ...r, legacyIds: byId.get(r.id)! } : r));
}

const opts = () => {
  let n = 0;
  return { userId: "user_001", now: 1_000, newId: () => `cl-${++n}` };
};

describe("planAuthorities", () => {
  const rows = [ent("e1", "ne-aaaaaa", 1), ent("e2", "ne-bbbbbb", 2)];
  const live = liveCodesByFederation(rows, []);

  it("appends the published code to the record holding the Django id", () => {
    const plan = planAuthorities("entity", [{ djangoId: "1", code: "ne-u3ufz" }], rows, live);
    expect(plan.refusals).toEqual([]);
    expect(plan.counts.toWrite).toBe(1);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].id).toBe("e1");
    expect(JSON.parse(plan.writes[0].newLegacyIds)).toEqual([
      { provider: "django-zasqua", id: 1 },
      { provider: "zasqua-2026-04", id: "ne-u3ufz" },
    ]);
    expect(plan.holdingBefore).toBe(0);
    expect(plan.holdingAfter).toBe(1);
  });

  it("plans nothing on a second run", () => {
    const file = [{ djangoId: "1", code: "ne-u3ufz" }, { djangoId: "2", code: "ne-x2x2x" }];
    const first = planAuthorities("entity", file, rows, live);
    expect(first.writes).toHaveLength(2);
    const second = planAuthorities("entity", file, applied(rows, first), live);
    expect(second.writes).toEqual([]);
    expect(second.counts).toMatchObject({ toWrite: 0, alreadyPresent: 2, refused: 0 });
    expect(buildStatements([second], opts())).toEqual([]);
  });

  it("refuses a file record with no pair and one with two", () => {
    const twin = [...rows, ent("e3", "ne-cccccc", 2)];
    const plan = planAuthorities(
      "entity",
      [{ djangoId: "9", code: "ne-nopai" }, { djangoId: "2", code: "ne-twins" }],
      twin,
      liveCodesByFederation(twin, []),
    );
    expect(plan.refusals.map((r) => r.reason)).toEqual(["no Fisqua pair", "two Fisqua pairs"]);
    expect(plan.writes).toEqual([]);
  });

  it("refuses a code equal to a live code in the federation", () => {
    const plan = planAuthorities("entity", [{ djangoId: "1", code: "ne-bbbbbb" }], rows, live);
    expect(plan.refusals[0].reason).toBe("retired code is a live code");
    expect(plan.writes).toEqual([]);
  });

  it("records a merged record's code on the record it was merged into", () => {
    const places = [
      ent("p-dup", "nl-nstfgb", 99306, { mergedInto: "p-main" }),
      ent("p-main", "nl-s9z5px", 96418),
    ];
    const plan = planAuthorities(
      "place",
      [{ djangoId: "99306", code: "nl-5mp87" }, { djangoId: "96418", code: "nl-bkc9a" }],
      places,
      liveCodesByFederation([], places),
    );
    expect(plan.refusals).toEqual([]);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].id).toBe("p-main");
    expect(plan.writes[0].added.map((a) => a.id)).toEqual(["nl-5mp87", "nl-bkc9a"]);
    expect(plan.mergesFollowed).toEqual([
      expect.objectContaining({ retiredCode: "nl-5mp87", pairedCode: "nl-nstfgb", survivorCode: "nl-s9z5px" }),
    ]);
  });

  it("records an unmerged duplicate's code on its own record", () => {
    const places = [ent("p-dup", "nl-nstfgb", 99306), ent("p-main", "nl-s9z5px", 96418)];
    const plan = planAuthorities("place", [{ djangoId: "99306", code: "nl-5mp87" }], places, liveCodesByFederation([], places));
    expect(plan.writes.map((w) => w.id)).toEqual(["p-dup"]);
    expect(plan.mergesFollowed).toEqual([]);
  });
});

describe("duplicateCodes", () => {
  it("refuses a code appearing twice across the files", () => {
    const out = duplicateCodes([
      { kind: "entity", code: "ne-aaaaa" },
      { kind: "place", code: "nl-bbbbb" },
      { kind: "place", code: "nl-bbbbb" },
    ]);
    expect(out).toEqual([{ kind: "place", reason: "code appears twice", detail: "nl-bbbbb (place, place)" }]);
  });
});

describe("dangling place codes", () => {
  const siteLinks = [
    { referenceCode: "co-ahrb-1", placeCode: "nl-z9ruz", role: "mentioned" },
    { referenceCode: "co-ahrb-1", placeCode: "nl-known", role: "mentioned" },
    { referenceCode: "co-ahrb-2", placeCode: "nl-z9ruz", role: "mentioned" },
    { referenceCode: "co-ahrb-3", placeCode: "nl-lost1", role: "mentioned" },
  ];
  const placeCodes = new Set(["nl-known"]);
  const dangling = danglingPlaceCodes(siteLinks, placeCodes);
  const byReference = new Map<string, typeof siteLinks>();
  for (const l of siteLinks) byReference.set(l.referenceCode, [...(byReference.get(l.referenceCode) ?? []), l]);
  // Descriptions whose reference codes have not changed since the site's files.
  const same = new Map([["co-ahrb-1", "d-1"], ["co-ahrb-2", "d-2"], ["co-ahrb-3", "d-3"]]);
  const places = [
    ent("p-palma", "nl-kp3cv8", 97587), ent("p-known", "nl-kkkkkk", 1),
    ent("p-a", "nl-aaaaaa", 2), ent("p-b", "nl-bbbbbb", 3), ent("p-x", "nl-xxxxxx", 4), ent("p-y", "nl-yyyyyy", 5),
  ];

  it("finds the codes with no place record", () => {
    expect([...dangling.keys()].sort()).toEqual(["nl-lost1", "nl-z9ruz"]);
  });

  it("resolves a code whose links all point to one Fisqua place, and leaves an ambiguous one alone", () => {
    const fisqua = [
      { descriptionId: "d-1", placeId: "p-palma", role: "mentioned" },
      { descriptionId: "d-1", placeId: "p-known", role: "mentioned" },
      { descriptionId: "d-2", placeId: "p-palma", role: "mentioned" },
      { descriptionId: "d-3", placeId: "p-a", role: "mentioned" },
      { descriptionId: "d-3", placeId: "p-b", role: "mentioned" },
    ];
    const out = resolveDangling({
      dangling, siteLinksByReference: byReference, descriptionBySiteReference: same, fisquaLinks: fisqua,
      placeIdBySiteCode: new Map([["nl-known", "p-known"]]), places,
    });
    expect(out).toEqual([
      expect.objectContaining({ code: "nl-lost1", placeId: null, candidates: ["p-a", "p-b"] }),
      expect.objectContaining({ code: "nl-z9ruz", links: 2, placeId: "p-palma", placeCode: "nl-kp3cv8", note: "resolved" }),
    ]);
  });

  it("does not resolve when links point to different places", () => {
    const fisqua = [
      { descriptionId: "d-1", placeId: "p-x", role: "mentioned" },
      { descriptionId: "d-2", placeId: "p-y", role: "mentioned" },
    ];
    const out = resolveDangling({
      dangling: new Map([["nl-z9ruz", dangling.get("nl-z9ruz")!]]), siteLinksByReference: byReference,
      descriptionBySiteReference: same, fisquaLinks: fisqua, placeIdBySiteCode: new Map(), places,
    });
    expect(out[0].placeId).toBeNull();
    expect(out[0].note).toBe("links point to different Fisqua places");
  });

  it("pairs a link's description by the site's reference code and Django id, not Fisqua's current code", () => {
    // The site published co-old for Django 5; Fisqua recoded it co-new and
    // gave co-old to Django 6, which is linked to another place.
    const descriptions = [desc("d-5", "co-new", dj(5)), desc("d-6", "co-old", dj(6))];
    const fileDescriptions = [
      { djangoId: "5", referenceCode: "co-old" },
      { djangoId: "6", referenceCode: "co-older" },
    ];
    const links = [{ referenceCode: "co-old", placeCode: "nl-z9ruz", role: "mentioned" }];
    const pairs = pairSiteReferences(["co-old"], fileDescriptions, descriptions);
    expect([...pairs]).toEqual([["co-old", "d-5"]]);
    const out = resolveDangling({
      dangling: danglingPlaceCodes(links, new Set()),
      siteLinksByReference: new Map([["co-old", links]]),
      descriptionBySiteReference: pairs,
      fisquaLinks: [
        { descriptionId: "d-5", placeId: "p-palma", role: "mentioned" },
        { descriptionId: "d-6", placeId: "p-x", role: "mentioned" },
      ],
      placeIdBySiteCode: new Map(),
      places,
    });
    expect(out[0]).toMatchObject({ code: "nl-z9ruz", placeId: "p-palma", note: "resolved" });
  });

  it("leaves a link alone whose site reference code pairs with no single Fisqua description", () => {
    const fileDescriptions = [
      { djangoId: "5", referenceCode: "co-twice" },
      { djangoId: "6", referenceCode: "co-twice" },
      { djangoId: "7", referenceCode: "co-gone" },
    ];
    const descriptions = [desc("d-5", "co-twice", dj(5)), desc("d-6", "x", dj(6))];
    expect(pairSiteReferences(["co-twice", "co-gone", "co-absent"], fileDescriptions, descriptions).size).toBe(0);
    const links = [{ referenceCode: "co-twice", placeCode: "nl-z9ruz", role: "mentioned" }];
    const out = resolveDangling({
      dangling: danglingPlaceCodes(links, new Set()), siteLinksByReference: new Map([["co-twice", links]]),
      descriptionBySiteReference: new Map(), fisquaLinks: [{ descriptionId: "d-5", placeId: "p-palma", role: "mentioned" }],
      placeIdBySiteCode: new Map(), places,
    });
    expect(out[0]).toMatchObject({ placeId: null, note: "co-twice pairs with no single Fisqua description" });
  });

  it("reads place pairings and Fisqua's links through merges", () => {
    // The site links co-1 to nl-mrgd1 (Django 40, since merged into p-surv)
    // and to the dangling code. The merge moved p-merged's link to p-surv.
    const merged = [
      ...places,
      ent("p-merged", "nl-mmmmmm", 40, { mergedInto: "p-surv" }),
      ent("p-surv", "nl-ssssss", 41),
    ];
    const bySite = placeIdsBySiteCode(
      [{ djangoId: "40", code: "nl-mrgd1" }, { djangoId: "97587", code: "nl-palm1" }],
      merged,
    );
    expect([...bySite]).toEqual([["nl-mrgd1", "p-surv"], ["nl-palm1", "p-palma"]]);
    const links = [
      { referenceCode: "co-1", placeCode: "nl-mrgd1", role: "mentioned" },
      { referenceCode: "co-1", placeCode: "nl-z9ruz", role: "mentioned" },
    ];
    const resolve = (fisquaLinks: Array<{ descriptionId: string; placeId: string; role: string }>) =>
      resolveDangling({
        dangling: danglingPlaceCodes(links, new Set(["nl-mrgd1"])), siteLinksByReference: new Map([["co-1", links]]),
        descriptionBySiteReference: new Map([["co-1", "d-1"]]), fisquaLinks, placeIdBySiteCode: bySite, places: merged,
      })[0];
    // Links moved to the survivor.
    expect(
      resolve([
        { descriptionId: "d-1", placeId: "p-surv", role: "mentioned" },
        { descriptionId: "d-1", placeId: "p-palma", role: "mentioned" },
      ]),
    ).toMatchObject({ placeId: "p-palma", note: "resolved" });
    // A link still on the merged record is read as the survivor's.
    expect(
      resolve([
        { descriptionId: "d-1", placeId: "p-merged", role: "mentioned" },
        { descriptionId: "d-1", placeId: "p-palma", role: "mentioned" },
      ]),
    ).toMatchObject({ placeId: "p-palma", note: "resolved" });
  });

  it("leaves out only the places the site links to the description in the dangling link's role", () => {
    // The site links p-palma's known code as created and the dangling code
    // as mentioned; Fisqua links p-palma in both roles.
    const links = [
      { referenceCode: "co-1", placeCode: "nl-palm1", role: "created" },
      { referenceCode: "co-1", placeCode: "nl-z9ruz", role: "mentioned" },
    ];
    const out = resolveDangling({
      dangling: danglingPlaceCodes(links, new Set(["nl-palm1"])),
      siteLinksByReference: new Map([["co-1", links]]),
      descriptionBySiteReference: new Map([["co-1", "d-1"]]),
      fisquaLinks: [
        { descriptionId: "d-1", placeId: "p-palma", role: "created" },
        { descriptionId: "d-1", placeId: "p-palma", role: "mentioned" },
      ],
      placeIdBySiteCode: new Map([["nl-palm1", "p-palma"]]),
      places,
    });
    expect(out[0]).toMatchObject({ code: "nl-z9ruz", placeId: "p-palma", note: "resolved" });
  });

  it("records a resolved code on the place like any other", () => {
    const rows = [ent("p-palma", "nl-kp3cv8", 97587)];
    const plan = planAuthorities("place", [], rows, liveCodesByFederation([], rows), [
      { code: "nl-z9ruz", recordId: "p-palma" },
    ]);
    expect(plan.writes[0].added).toEqual([{ provider: "zasqua-2026-04", id: "nl-z9ruz" }]);
  });
});

describe("planDescriptions", () => {
  const rows = [
    desc("d1", "co-cihjml-acc-00113-civil-i-a", dj(10)),
    desc("d2", "co-cihjml-acc-1", dj(11)),
    desc("d3", "co-ahr-con-caj002-car001", dj(12, [{ provider: "former-reference-code", id: "co-ahr-con-caj002-c1" }])),
    // The survivor of a merge holds both Django ids.
    desc("d4", "co-ahr-jud-caj1033", JSON.stringify([{ provider: "django-zasqua", id: 13 }, { provider: "django-zasqua", id: 176519 }])),
  ];
  const file = [
    { djangoId: "10", referenceCode: "co-cihjml-acc-00113-civil-i-a" },
    { djangoId: "11", referenceCode: "co-cihjml-acc-1?" },
    { djangoId: "12", referenceCode: "co-ahr-con-caj002-c1" },
    { djangoId: "13", referenceCode: "co-ahr-jud-caj1033" },
    { djangoId: "176519", referenceCode: "co-ahr-jud-caj103" },
  ];

  it("records changed codes, skips ones already recorded, and gives the survivor the absorbed code", () => {
    const plan = planDescriptions(file, rows);
    expect(plan.refusals).toEqual([]);
    expect(plan.counts).toMatchObject({ fileRecords: 5, toWrite: 2, alreadyPresent: 1, unchanged: 2 });
    expect(plan.writes.map((w) => [w.id, w.added])).toEqual([
      ["d2", [{ provider: "former-reference-code", id: "co-cihjml-acc-1?" }]],
      ["d4", [{ provider: "former-reference-code", id: "co-ahr-jud-caj103" }]],
    ]);
    expect(plan.holdingBefore).toBe(1);
    expect(plan.holdingAfter).toBe(3);
    expect(planDescriptions(file, applied(rows, plan)).writes).toEqual([]);
  });

  it("refuses an old reference code that is a live one in the tenant", () => {
    const plan = planDescriptions([{ djangoId: "11", referenceCode: "co-ahr-jud-caj1033" }], rows);
    expect(plan.refusals[0].reason).toBe("retired code is a live code");
  });

  it("reports, and does not refuse, an old code already recorded that is now another record's code", () => {
    const shifted = [
      desc("a", "co-ahr-con-caj002-car001", dj(20, [{ provider: "former-reference-code", id: "co-ahr-con-caj002-car002" }])),
      desc("b", "co-ahr-con-caj002-car002", dj(21, [{ provider: "former-reference-code", id: "co-ahr-con-caj002-car003" }])),
    ];
    const plan = planDescriptions(
      [
        { djangoId: "20", referenceCode: "co-ahr-con-caj002-car002" },
        { djangoId: "21", referenceCode: "co-ahr-con-caj002-car003" },
      ],
      shifted,
    );
    expect(plan.refusals).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.counts.alreadyPresent).toBe(2);
    expect(plan.warnings).toEqual([
      expect.objectContaining({ reason: "already recorded, and a live code", detail: expect.stringContaining("co-ahr-con-caj002-car002 (now co-ahr-con-caj002-car001)") }),
    ]);
  });

  it("refuses a description with no pair", () => {
    const plan = planDescriptions([{ djangoId: "999", referenceCode: "co-x" }], rows);
    expect(plan.refusals[0].reason).toBe("no Fisqua pair");
  });
});

describe("buildStatements", () => {
  const rows = [ent("e1", "ne-aaaaaa", 1)];
  const plan = planAuthorities("entity", [{ djangoId: "1", code: "ne-u3ufz" }], rows, liveCodesByFederation(rows, []));
  const descPlan = planDescriptions(
    [{ djangoId: "11", referenceCode: "old-code" }],
    [desc("d2", "new-code", dj(11))],
  );

  it("scopes every write by tenant (or federation) and id and the legacy_ids read", () => {
    const sql = buildStatements([plan, descPlan], opts());
    const writes = sql.filter((s) => s.startsWith("UPDATE") || s.startsWith("INSERT"));
    expect(writes).toHaveLength(4);
    for (const s of writes) {
      expect(s).toMatch(/WHERE (tenant_id = 't-1'|federation_id = 'fed-1' AND tenant_id IS NULL) AND id = '/);
      expect(s).toContain("AND legacy_ids = '");
    }
    expect(sql[0]).toContain("= 0 THEN 1 ELSE json('ABORT");
    expect(sql[sql.length - 1]).toContain("= 1 THEN 1 ELSE json('ABORT");
  });

  it("guards each record on the legacy_ids read, before its changelog row and UPDATE", () => {
    const sql = buildStatements([plan, descPlan], opts());
    const i = sql.findIndex((s) => s.startsWith("INSERT INTO changelog"));
    expect(sql[i - 1]).toMatch(/^SELECT CASE WHEN \(SELECT count\(\*\) FROM entities WHERE federation_id = 'fed-1' .* AND merged_into IS NULL AND legacy_ids = '.*' AND updated_at = 500\) = 1 THEN 1 ELSE json\('ABORT/);
  });

  it("fails the whole file when a record that already held the provider changed since the read", () => {
    // e1 already holds one retired code and gains another; e2 gains its first.
    const held = JSON.stringify([{ provider: "django-zasqua", id: 1 }, { provider: "zasqua-2026-04", id: "ne-first" }]);
    const rows2 = [ent("e1", "ne-aaaaaa", 1, { legacyIds: held }), ent("e2", "ne-bbbbbb", 2)];
    const plan2 = planAuthorities(
      "entity",
      [{ djangoId: "1", code: "ne-secnd" }, { djangoId: "2", code: "ne-third" }],
      rows2,
      liveCodesByFederation(rows2, []),
    );
    expect(plan2.writes.map((w) => w.id)).toEqual(["e1", "e2"]);
    const db = entityDb(rows2);
    // Changed between the read and the apply, still holding the provider.
    const changed = JSON.stringify([...JSON.parse(held), { provider: "other", id: "x" }]);
    db.prepare("UPDATE entities SET legacy_ids = ? WHERE id = 'e1'").run(changed);
    const statements = buildStatements([plan2], opts());
    expect(() => applyAll(db, statements)).toThrow();
    const after = db.prepare("SELECT id, legacy_ids FROM entities ORDER BY id").all() as Array<{ id: string; legacy_ids: string }>;
    expect(after).toEqual([
      { id: "e1", legacy_ids: changed },
      { id: "e2", legacy_ids: rows2[1].legacyIds },
    ]);
    expect(changelogRows(db)).toBe(0);

    // Unchanged, the same statements apply in full.
    db.prepare("UPDATE entities SET legacy_ids = ? WHERE id = 'e1'").run(held);
    applyAll(db, statements);
    expect(changelogRows(db)).toBe(2);
    db.close();
  });

  it("counts providers through the JSON, whatever the spacing of the stored text", () => {
    // Stored with spaces after the colons; the planner reads it as holding the provider.
    const spaced = '[{"provider": "django-zasqua", "id": 1}, {"provider": "zasqua-2026-04", "id": "ne-first"}]';
    const rows2 = [ent("e1", "ne-aaaaaa", 1, { legacyIds: spaced })];
    const plan2 = planAuthorities("entity", [{ djangoId: "1", code: "ne-secnd" }], rows2, liveCodesByFederation(rows2, []));
    expect([plan2.holdingBefore, plan2.holdingAfter]).toEqual([1, 1]);
    const db = entityDb(rows2);
    applyAll(db, buildStatements([plan2], opts()));
    expect(JSON.parse((db.prepare("SELECT legacy_ids AS l FROM entities").get() as { l: string }).l)).toContainEqual({
      provider: "zasqua-2026-04", id: "ne-secnd",
    });
    expect((db.prepare(holdingCountSql("entities", "zasqua-2026-04")).get() as { n: number }).n).toBe(1);
    db.close();
  });

  it("fails the whole file when a record to write was merged or touched after the read", () => {
    const rows2 = [ent("e1", "ne-aaaaaa", 1), ent("e2", "ne-bbbbbb", 2)];
    const plan2 = planAuthorities("entity", [{ djangoId: "2", code: "ne-x2x2x" }], rows2, liveCodesByFederation(rows2, []));
    expect(plan2.writes.map((w) => w.id)).toEqual(["e2"]);
    const statements = buildStatements([plan2], opts());
    for (const change of [
      "UPDATE entities SET merged_into = 'e1', updated_at = 900 WHERE id = 'e2'", // a merge, as the app writes it
      "UPDATE entities SET merged_into = 'e1' WHERE id = 'e2'", // merged, stamp unchanged
      "UPDATE entities SET updated_at = 900 WHERE id = 'e2'", // edited, legacy_ids unchanged
    ]) {
      const db = entityDb(rows2);
      db.exec(change);
      expect(() => applyAll(db, statements), change).toThrow();
      expect((db.prepare("SELECT legacy_ids AS l FROM entities WHERE id = 'e2'").get() as { l: string }).l).toBe(rows2[1].legacyIds);
      expect(changelogRows(db)).toBe(0);
      db.close();
    }
    const db = entityDb(rows2);
    applyAll(db, statements);
    expect(changelogRows(db)).toBe(1);
    db.close();
  });

  it("fails the whole file when a former reference code to record became another description's code after the read", () => {
    const rows2 = [desc("d-a", "co-new", dj(1)), desc("d-b", "co-b", dj(2))];
    const plan2 = planDescriptions([{ djangoId: "1", referenceCode: "co-old" }], rows2);
    expect(plan2.writes.map((w) => w.id)).toEqual(["d-a"]);
    const statements = buildStatements([plan2], opts());
    const seed = (db: DatabaseSync) => {
      const ins = db.prepare("INSERT INTO descriptions VALUES (?, ?, ?, ?, ?, NULL)");
      for (const d of rows2) ins.run(d.id, d.tenantId, d.referenceCode, d.legacyIds, d.updatedAt);
    };
    const db = entityDb([]);
    seed(db);
    db.exec("UPDATE descriptions SET reference_code = 'co-old' WHERE id = 'd-b'");
    expect(() => applyAll(db, statements)).toThrow();
    expect((db.prepare("SELECT legacy_ids AS l FROM descriptions WHERE id = 'd-a'").get() as { l: string }).l).toBe(rows2[0].legacyIds);
    expect(changelogRows(db)).toBe(0);
    db.close();
    // In another tenant the same code is no collision.
    const other = entityDb([]);
    seed(other);
    other.exec("UPDATE descriptions SET reference_code = 'co-old', tenant_id = 't-2' WHERE id = 'd-b'");
    applyAll(other, statements);
    expect(changelogRows(other)).toBe(1);
    other.close();
  });

  it("fails the whole file when a retired code to record became an entity or place code in the federation after the read", () => {
    const rows2 = [ent("e1", "ne-aaaaaa", 1), ent("e2", "ne-bbbbbb", 2)];
    const plan2 = planAuthorities("entity", [{ djangoId: "2", code: "ne-x2x2x" }], rows2, liveCodesByFederation(rows2, []));
    const statements = buildStatements([plan2], opts());
    for (const [change, collides] of [
      ["UPDATE entities SET entity_code = 'ne-x2x2x' WHERE id = 'e1'", true],
      ["INSERT INTO places VALUES ('p1', 'fed-1', NULL, 'ne-x2x2x', NULL, '[]', 1)", true],
      ["INSERT INTO places VALUES ('p1', 'fed-2', NULL, 'ne-x2x2x', NULL, '[]', 1)", false],
    ] as const) {
      const db = entityDb(rows2);
      db.exec(change);
      if (collides) {
        expect(() => applyAll(db, statements), change).toThrow();
        expect(changelogRows(db)).toBe(0);
      } else {
        applyAll(db, statements);
        expect(changelogRows(db)).toBe(1);
      }
      db.close();
    }
  });

  it("splits the live-code guards so that no statement exceeds the size limit", () => {
    const n = 20_000;
    const rows2 = Array.from({ length: n }, (_, i) => ent(`e${i}`, `ne-live${i}`, i));
    const file = rows2.map((_, i) => ({ djangoId: String(i), code: `ne-${String(i).padStart(6, "0")}` }));
    const plan2 = planAuthorities("entity", file, rows2, liveCodesByFederation(rows2, []));
    const guards = liveCodeGuards(plan2);
    expect(guards.length).toBeGreaterThan(1);
    for (const g of guards) expect(Buffer.byteLength(g)).toBeLessThanOrEqual(GUARD_STATEMENT_BYTES);
    const covered = new Set(guards.flatMap((g) => g.match(/IN \(([^)]*)\)/)![1].split(", ")));
    expect(covered.size).toBe(n);
    for (const s of buildStatements([plan2], opts())) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(50_000);
  });

  it("never writes a code", () => {
    const sql = buildStatements([plan, descPlan], opts());
    for (const s of sql.filter((x) => x.startsWith("UPDATE"))) {
      const set = s.slice(s.indexOf(" SET "), s.indexOf(" WHERE "));
      expect(set).not.toMatch(/entity_code|place_code|reference_code/);
      expect(set).toMatch(/^ SET legacy_ids = /);
    }
  });

  it("writes changelog rows under the user, and none without one", () => {
    const withUser = buildStatements([plan, descPlan], opts());
    const changelog = withUser.filter((s) => s.startsWith("INSERT INTO changelog"));
    expect(changelog).toHaveLength(2);
    expect(changelog[0]).toContain("'user_001'");
    expect(changelog[0]).toContain("'entity'");
    expect(changelog[1]).toContain("'description'");
    expect(withUser.find((s) => s.startsWith("UPDATE descriptions"))).toContain("updated_by = 'user_001'");
    const without = buildStatements([plan, descPlan], { ...opts(), userId: null });
    expect(without.some((s) => s.includes("changelog"))).toBe(false);
    expect(without.some((s) => s.includes("updated_by"))).toBe(false);
  });
});

describe("streamJsonArray", () => {
  const dir = mkdtempSync(join(tmpdir(), "retired-codes-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };
  const collect = async (p: string) => {
    const out: unknown[] = [];
    for await (const x of streamJsonArray(p)) out.push(x);
    return out;
  };

  it("yields each element, strings with brackets and escapes included", async () => {
    const items = [{ a: "x]}\"[{", b: [1, { c: "\\" }] }, { id: 2, t: "Zipaquirá" }];
    expect(await collect(file("ok.json", JSON.stringify(items, null, 2)))).toEqual(items);
    expect(await collect(file("empty.json", " [ ] \n"))).toEqual([]);
  });

  it("reads elements that span read chunks", async () => {
    const items = Array.from({ length: 3000 }, (_, i) => ({ id: i, text: "é".repeat(500) }));
    const out = await collect(file("big.json", JSON.stringify(items)));
    expect(out).toHaveLength(3000);
    expect(out[2999]).toEqual(items[2999]);
  });

  it("refuses JSON that does not parse", async () => {
    await expect(collect(file("bad.json", '[{"a": 1}, {"a": tru}]'))).rejects.toThrow(/does not parse/);
    await expect(collect(file("cut.json", '[{"a": 1}, {"a"'))).rejects.toThrow(/incomplete/);
    await expect(collect(file("obj.json", '{"a": 1}'))).rejects.toThrow(/not a JSON array/);
  });

  it("refuses an array whose elements are not separated by exactly one comma", async () => {
    await expect(collect(file("double.json", "[{},,{}]"))).rejects.toThrow(/unexpected comma/);
    await expect(collect(file("trailing.json", "[{}, ]"))).rejects.toThrow(/trailing comma/);
    await expect(collect(file("leading.json", "[ ,{}]"))).rejects.toThrow(/unexpected comma/);
    await expect(collect(file("lone.json", "[,]"))).rejects.toThrow(/unexpected comma/);
    await expect(collect(file("missing.json", "[{}{}]"))).rejects.toThrow(/missing comma/);
    await expect(collect(file("missing2.json", '[{"a":1}\n [2]]'))).rejects.toThrow(/missing comma/);
    expect(await collect(file("one.json", "[{}]"))).toEqual([{}]);
    expect(await collect(file("spaced.json", "[ {} ,\n{} ]"))).toEqual([{}, {}]);
  });
});

describe("who writes the retired codes", () => {
  // fed-1 is led by t-lead (`neogranadina`); t-ahr (`ahr`) is its member. fed-2 is led by t-far.
  function actingDb(): DatabaseSync {
    const db = entityDb([]);
    db.exec(`CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT, status TEXT, lead_tenant_id TEXT, shared_authorities_enabled INTEGER);
      CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, kind TEXT NOT NULL DEFAULT 'tenant', status TEXT, federation_id TEXT, disabled_at INTEGER,
        authorities_enabled INTEGER);
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, tenant_id TEXT, is_admin INTEGER DEFAULT 0, is_super_admin INTEGER DEFAULT 0,
        is_records_admin INTEGER DEFAULT 0, is_authorities_admin INTEGER DEFAULT 0, is_imports_admin INTEGER DEFAULT 0,
        is_digitization_admin INTEGER DEFAULT 0, is_platform_admin INTEGER DEFAULT 0);
      CREATE TABLE federation_memberships (id TEXT PRIMARY KEY, user_id TEXT, federation_id TEXT, role TEXT);
      INSERT INTO federations VALUES ('fed-1', 'neogranadina', 'active', 't-lead', 1), ('fed-2', 'otra', 'active', 't-far', 1);
      INSERT INTO tenants (id, slug, federation_id, authorities_enabled) VALUES ('t-lead', 'neogranadina', 'fed-1', 1), ('t-ahr', 'ahr', 'fed-1', 1),
        ('t-far', 'far', 'fed-2', 1);
      INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'lead@example.org', 'Lead', 't-lead', 1);
      INSERT INTO descriptions VALUES ('d-lead', 't-lead', 'co-lead-1', '${dj(21)}', 500, NULL), ('d-ahr', 't-ahr', 'co-ahr-1', '${dj(22)}', 500, NULL);`);
    db.prepare("INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?)").run("e1", "fed-1", null, "ne-aaaaaa", null, dj(1), 500);
    return db;
  }
  const reader = (db: DatabaseSync) => async (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
  const plans = (shared: AuthorityRow[] = [ent("e1", "ne-aaaaaa", 1)]) => [
    planAuthorities("entity", [{ djangoId: "1", code: "ne-u3ufz" }], shared, liveCodesByFederation(shared, [])),
    planDescriptions(
      [{ djangoId: "21", referenceCode: "co-lead-old" }, { djangoId: "22", referenceCode: "co-ahr-old" }],
      [{ ...desc("d-lead", "co-lead-1", dj(21)), tenantId: "t-lead" }, { ...desc("d-ahr", "co-ahr-1", dj(22)), tenantId: "t-ahr" }],
    ),
  ];

  it("records lead-admin on a member's description, and NULL on the lead's own and on a shared record", async () => {
    const db = actingDb();
    const p = plans();
    const acting = await retiredCodeActing(reader(db), "lead@example.org", p.flatMap((x) => x.writes));
    applyAll(db, [...acting.guards, ...buildStatements(p, { ...opts(), actedAs: acting.actedAs })]);
    expect(db.prepare("SELECT record_id, acted_as FROM changelog ORDER BY record_id").all()).toEqual([
      { record_id: "d-ahr", acted_as: "lead-admin" },
      { record_id: "d-lead", acted_as: null },
      { record_id: "e1", acted_as: null },
    ]);
  });

  it("fails the file when the lead's admin loses the admin role before the apply", async () => {
    const db = actingDb();
    const p = plans();
    const acting = await retiredCodeActing(reader(db), "lead@example.org", p.flatMap((x) => x.writes));
    db.exec("UPDATE users SET is_admin = 0 WHERE id = 'user_001'");
    expect(() => applyAll(db, [...acting.guards, ...buildStatements(p, { ...opts(), actedAs: acting.actedAs })])).toThrow();
    expect(changelogRows(db)).toBe(0);
  });

  it("stops on a description of another federation, and on shared records of a federation the user is no steward of", async () => {
    const db = actingDb();
    db.exec("INSERT INTO descriptions VALUES ('d-far', 't-far', 'co-far-1', '" + dj(23) + "', 500, NULL)");
    const far = planDescriptions([{ djangoId: "23", referenceCode: "co-far-old" }], [{ ...desc("d-far", "co-far-1", dj(23)), tenantId: "t-far" }]);
    await expect(retiredCodeActing(reader(db), "lead@example.org", far.writes)).rejects.toThrow(/lead@example.org may not act in far/);
    const shared = [ent("e9", "oe-aaaaaa", 9, { federationId: "fed-2" })];
    const farShared = planAuthorities("entity", [{ djangoId: "9", code: "oe-u3ufz" }], shared, liveCodesByFederation(shared, []));
    await expect(retiredCodeActing(reader(db), "lead@example.org", farShared.writes)).rejects.toThrow(/may not act in far/);
    db.exec("UPDATE users SET is_admin = 0, is_records_admin = 1 WHERE id = 'user_001'");
    await expect(retiredCodeActing(reader(db), "lead@example.org", plans()[0].writes)).rejects.toThrow(
      /lead@example.org is not a steward of neogranadina, whose shared records the run changes/,
    );
  });
});

// @version v0.9.0
