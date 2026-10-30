/**
 * Tests — migration 0099, the provisioning locks
 *
 * This suite applies migration 0099 to an in-memory SQLite and runs the
 * statements the storage commands send through `wrangler d1 execute`
 * (`takeLockStatements`, `releaseLockStatement`) against it:
 *
 *   - a free scope is taken by the first run, and a second run's insert
 *     leaves it with the first, which both read back;
 *   - an expired lock is cleared and taken by the next run;
 *   - a run releases only its own lock;
 *   - two scopes are independent;
 *   - a pair is marked once per scope with its writer's token (a mark
 *     left earlier is replaced), and cleared only when the mark is the
 *     clearing run's own and its token holds the scope's unexpired lock,
 *     the statement returning the row it cleared;
 *   - a lock is renewed only for its token while it has not expired; a
 *     lost lock cannot be renewed;
 *   - a fenced mark is written only while the token holds the lock;
 *   - the destination UPDATE is written only while the token holds the
 *     lock and every record column still has the value read, and returns
 *     the row it changed.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  clearPairStatement,
  fencedDestinationStatement,
  markPairStatement,
  releaseLockStatement,
  renewLockStatements,
  takeLockStatements,
} from "../../scripts/lib/tenant-storage";

const migration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(migration("0099_provisioning_locks.sql"));
  return db;
}

/** Runs the take statements as one command and returns the last statement's row, as wrangler would. */
function take(db: DatabaseSync, scope: string, holder: string, now: number, expiresAt: number) {
  // The holder's name doubles as its token here.
  const statements = takeLockStatements(scope, holder, holder, now, expiresAt).split("; ");
  for (const sql of statements.slice(0, -1)) db.exec(sql);
  const row = db.prepare(statements.at(-1)!).get() as { holder: string; token: string; started_at: number };
  return { holder: row.holder, started_at: row.started_at };
}

/** Runs the renew statements and says whether the lock is still held. */
function renew(db: DatabaseSync, scope: string, token: string, now: number, expiresAt: number): boolean {
  const statements = renewLockStatements(scope, token, now, expiresAt).split("; ");
  db.exec(statements[0]);
  return db.prepare(statements[1]).all().length > 0;
}

describe("migration 0099 and the lock statements", () => {
  it("lets the first run take a free scope and keeps it from the second", () => {
    const db = database();
    expect(take(db, "federation:f-1", "run-a", 100, 200)).toEqual({ holder: "run-a", started_at: 100 });
    expect(take(db, "federation:f-1", "run-b", 150, 250)).toEqual({ holder: "run-a", started_at: 100 });
  });

  it("clears an expired lock for the next run", () => {
    const db = database();
    take(db, "tenant:t-1", "run-a", 100, 200);
    expect(take(db, "tenant:t-1", "run-b", 200, 300)).toEqual({ holder: "run-b", started_at: 200 });
  });

  it("releases only the holder's own lock, and keeps scopes apart", () => {
    const db = database();
    take(db, "tenant:t-1", "run-a", 100, 200);
    take(db, "tenant:t-2", "run-b", 100, 200);
    db.exec(releaseLockStatement("tenant:t-1", "run-b"));
    expect(take(db, "tenant:t-1", "run-c", 150, 250).holder).toBe("run-a");
    db.exec(releaseLockStatement("tenant:t-1", "run-a"));
    expect(take(db, "tenant:t-1", "run-c", 160, 260).holder).toBe("run-c");
    expect(take(db, "tenant:t-2", "run-d", 160, 260).holder).toBe("run-b");
  });

  it("marks a pair with its writer's token, and clears only the writer's own mark while it holds the lock", () => {
    const db = database();
    db.exec(markPairStatement("tenant:t-1", "fisqua-x-delete", "run-a", "run-a", 1));
    db.exec(markPairStatement("tenant:t-1", "fisqua-x-delete", "run-b", "run-b", 2));
    db.exec(markPairStatement("tenant:t-2", "fisqua-x-delete", "run-c", "run-c", 3));
    const rows = () => db.prepare("SELECT scope, pair, holder, token, started_at FROM provisioning_pending_pairs ORDER BY scope").all();
    expect(rows()).toEqual([
      { scope: "tenant:t-1", pair: "fisqua-x-delete", holder: "run-b", token: "run-b", started_at: 2 },
      { scope: "tenant:t-2", pair: "fisqua-x-delete", holder: "run-c", token: "run-c", started_at: 3 },
    ]);
    const clear = (scope: string, token: string, now: number) =>
      db.prepare(clearPairStatement(scope, "fisqua-x-delete", token, now)).all().length;
    // Not while the token holds no lock.
    expect(clear("tenant:t-1", "run-b", 5)).toBe(0);
    take(db, "tenant:t-1", "run-b", 4, 100);
    // Not another writer's mark, even with the lock.
    db.exec(markPairStatement("tenant:t-1", "fisqua-x-delete", "run-a", "run-a", 6));
    expect(clear("tenant:t-1", "run-b", 7)).toBe(0);
    expect(rows()).toHaveLength(2);
    // Its own mark, with the lock: one row.
    db.exec(markPairStatement("tenant:t-1", "fisqua-x-delete", "run-b", "run-b", 8));
    expect(clear("tenant:t-1", "run-b", 9)).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(clear("tenant:t-2", "run-c", 9)).toBe(0);
  });

  it("renews a lock only for its token while it has not expired", () => {
    const db = database();
    take(db, "tenant:t-1", "run-a", 100, 200);
    expect(renew(db, "tenant:t-1", "run-a", 150, 250)).toBe(true);
    expect(renew(db, "tenant:t-1", "run-b", 160, 260)).toBe(false);
    // Past its (renewed) expiry the lock is lost, and another run takes it.
    expect(renew(db, "tenant:t-1", "run-a", 250, 350)).toBe(false);
    expect(take(db, "tenant:t-1", "run-b", 251, 400).holder).toBe("run-b");
    expect(renew(db, "tenant:t-1", "run-a", 252, 450)).toBe(false);
  });

  it("writes a fenced mark only while the token holds the lock", () => {
    const db = database();
    const mark = (now: number) => db.prepare(markPairStatement("tenant:t-1", "fisqua-x-write", "run-a", "run-a", now, true)).all().length;
    expect(mark(1)).toBe(0);
    take(db, "tenant:t-1", "run-a", 1, 100);
    expect(mark(2)).toBe(1);
    expect(mark(100)).toBe(0);
  });

  it("writes the destination only with the lock and the values read", () => {
    const db = database();
    db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL, slug TEXT NOT NULL)");
    db.exec("CREATE TABLE pipeline_run_volumes (tenant_id TEXT NOT NULL)");
    db.exec("CREATE TABLE federations (id TEXT PRIMARY KEY NOT NULL, slug TEXT NOT NULL UNIQUE)");
    db.exec(migration("0091_tenant_destinations.sql"));
    db.exec(migration("0097_review_tiles_bucket.sql"));
    db.exec("INSERT INTO federations (id, slug) VALUES ('f-1', 'acme')");
    const read = () => db.prepare("SELECT * FROM federations WHERE id = 'f-1'").get() as any;
    const values = {
      pipeline_delivery_endpoint: "https://e.example.test",
      pipeline_tiles_bucket: "t-bucket",
      pipeline_masters_bucket: "m-bucket",
      pipeline_image_base_url: "https://i.example.test",
      manifest_endpoint: "https://r.example.test",
      manifest_bucket: "mf-bucket",
      manifest_base_url: "https://mm.example.test",
      storage_secret_prefix: "P",
      pipeline_review_tiles_bucket: "r-bucket",
    };
    const fence = { scope: "federation:f-1", token: "run-a", now: 5 };
    const write = (expected: any) => db.prepare(fencedDestinationStatement("f-1", values, expected, fence)).all().length;
    const snapshot = read();
    // No lock: nothing written.
    expect(write(snapshot)).toBe(0);
    take(db, "federation:f-1", "run-a", 1, 100);
    // A stale snapshot: nothing written.
    db.exec("UPDATE federations SET pipeline_masters_bucket = 'other' WHERE id = 'f-1'");
    expect(write(snapshot)).toBe(0);
    expect(read().pipeline_tiles_bucket).toBeNull();
    // The values read, with the lock: written.
    expect(write(read())).toBe(1);
    expect(read()).toMatchObject(values);
  });

  it("escapes the scope and the holder", () => {
    const db = database();
    expect(take(db, "tenant:o'brien", "op'erator", 1, 2)).toEqual({ holder: "op'erator", started_at: 1 });
  });
});

// @version v0.8.0
