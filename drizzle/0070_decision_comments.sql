-- Comments on pending decisions: a comment, an author, and a date.
--
-- A pending decision carries a conversation, and its participants are
-- not one kind of thing: the import pipeline that filed the question
-- writes its synthesis as the first comment under the agency's name
-- ("AMPL"); a colleague can add a reading; the admin rules. These are
-- not qualitatively different messages, so they share one table and
-- one surface — the payload keeps only the actionable fields (what
-- would be created) and the requires-judgement flag, which carries
-- behaviour rather than content.
--
-- The author is EITHER a user (author_user_id, display name resolved
-- at render) OR a label (author_label) for non-user authors — an
-- agency, a pipeline. Exactly one is set; the CHECK enforces it.
--
-- The crowdsourcing comments table is deliberately not reused: it is
-- volume-anchored (volume_id NOT NULL) and its author is a users FK,
-- neither of which fits a question whose first commenter is an
-- institution.
--
-- Version: v0.7.0

CREATE TABLE decision_comments (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES pending_decisions(id) ON DELETE cascade,
  author_user_id TEXT REFERENCES users(id) ON DELETE restrict,
  author_label TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((author_user_id IS NULL) != (author_label IS NULL))
);

CREATE INDEX idx_decision_comments_decision
  ON decision_comments (decision_id, created_at);
