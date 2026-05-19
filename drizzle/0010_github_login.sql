-- GitHub identity on users
--
-- This migration adds a nullable `github_id` text column to `users`
-- so an account can be linked to its GitHub numeric id on first
-- sign-in via the Arctic-driven OAuth flow. A unique index enforces
-- one-to-one linkage and lets the callback path look the row up by
-- GitHub id without a sequential scan. Existing accounts keep
-- `github_id` NULL until they next authenticate through GitHub.
--
-- Version: v0.3.0

ALTER TABLE users ADD COLUMN github_id TEXT;
CREATE UNIQUE INDEX users_github_id_idx ON users(github_id);
