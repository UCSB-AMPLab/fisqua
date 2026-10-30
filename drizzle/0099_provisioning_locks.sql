-- Provisioning locks and pairs being written.
--
-- This migration adds provisioning locks and a record of the key pairs
-- being written. The operator's storage commands issue keys and keep each
-- one as two secrets, its id and its secret, written one after the other:
-- Worker secrets for Fisqua's keys (provision-federation-storage) and
-- GitHub Environment secrets for the runner's (provision-tenant-storage).
-- Two applied runs for one destination at the same time could leave one
-- run's key id beside the other run's secret, a pair that matches no key,
-- and later runs would find both secrets set and replace neither.
--
-- `provisioning_locks` holds one row per destination being provisioned,
-- so only one applied run works on it at a time:
--
--   - `scope`: `federation:{federation id}` for the federation step,
--     `tenant:{tenant id}` for the tenant step;
--   - `holder`: who runs it (operator, machine and process), named to a
--     second run that is refused;
--   - `token`: a random value per run, the lock's fencing token. Before
--     and after each secret write the run renews the lock with an UPDATE
--     that matches its token and an unexpired row; no row matched means
--     the lock is lost, and the run stops without writing again. A mark
--     is cleared only in a statement that matches the token too;
--   - `started_at`, `expires_at`: milliseconds since the epoch. A run
--     takes the lock with one atomic INSERT OR IGNORE after deleting an
--     expired row, renews it before and after each secret write, and
--     deletes its own row when it ends; a run that crashed leaves a row
--     that another run may replace once it expires.
--
-- `provisioning_pending_pairs` records, for each key whose two secrets a
-- run is writing, that the write has begun: a row is inserted before the
-- key is issued and deleted once both secrets are written. A row still
-- there when a later run reads it means the earlier run stopped between
-- the two writes, so the secrets may hold two different keys; that run
-- issues the pair again from scratch, whatever the account shows.
--
--   - `scope`: the destination, as for the lock;
--   - `pair`: the key's name, which names its two secrets;
--   - `holder`, `started_at`: the run that began writing it, and when;
--   - `token`: that run's lock token. Every mark, a re-mark included,
--     is written with the writer's token, and a run clears a mark only
--     when the token is its own and it still holds the lock. A run whose
--     mark was replaced by another writer leaves it, so the next run
--     issues the pair again.
--
-- A dry run writes nothing, takes no lock and marks no pair. Nothing in
-- the app reads or writes these tables.
--
-- Version: v0.8.0

CREATE TABLE provisioning_locks (
  scope TEXT PRIMARY KEY NOT NULL,
  holder TEXT NOT NULL,
  token TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE provisioning_pending_pairs (
  scope TEXT NOT NULL,
  pair TEXT NOT NULL,
  holder TEXT NOT NULL,
  token TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (scope, pair)
);
