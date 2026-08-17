-- Tier-1 email notifications: the outbox, and the user preferences
-- that govern it.
--
-- Notifications never send inline. Each Tier-1 event (a proposal
-- ruled, a comment on a decision thread, a human-filed proposal) fans
-- out one row per recipient into notification_outbox at action time;
-- a 15-minute cron sweep coalesces every pending row for a due
-- recipient into one digest email. sent_at NULL = pending. Bulk
-- ruling is the decisions surface's normal workflow, so per-event
-- mail was rejected by design: ruling a 300-row queue must produce
-- one email, not 300.
--
-- decision_id is ON DELETE RESTRICT for the same reason the comments
-- FK is: a decision carrying its case file is never hard-deleted.
-- user_id cascades -- a deleted account takes its unread mail with it.
--
-- users grows three columns: digest_frequency ('15min' | 'hourly' |
-- 'daily' | 'weekly' | 'off', default hourly -- 15min is the cron
-- tick, so it is the floor); last_digest_at, the sweep's per-user
-- clock (due when now - last_digest_at >= interval, drift-based, no
-- timezone machinery); and locale ('en' | 'es'), persisted from the
-- /configuracion language toggle so the digest can render in the
-- recipient's language (NULL falls back to es). Existing users keep
-- NULL last_digest_at (immediately due when something is pending) and
-- NULL locale.
--
-- Version: v0.7.0

CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES pending_decisions(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE INDEX idx_notification_outbox_pending
  ON notification_outbox (user_id, sent_at);

ALTER TABLE users ADD COLUMN digest_frequency TEXT NOT NULL DEFAULT 'hourly';
ALTER TABLE users ADD COLUMN last_digest_at INTEGER;
ALTER TABLE users ADD COLUMN locale TEXT;
