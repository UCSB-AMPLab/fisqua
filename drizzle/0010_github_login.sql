ALTER TABLE users ADD COLUMN github_id TEXT;
CREATE UNIQUE INDEX users_github_id_idx ON users(github_id);
