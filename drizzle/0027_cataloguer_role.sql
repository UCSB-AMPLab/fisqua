-- Cataloguer role flag
--
-- Adds `is_cataloguer` to `users` as a system-level marker for
-- cataloguing staff. The flag controls two surfaces: it reveals the
-- Cataloguing section of the sidebar to the user, and it makes the
-- user pickable in the project team picker so a collab admin can
-- assign volumes to them without needing to hold the user-manager
-- role. Additive and defaults to 0.
--
-- Version: v0.3.0

ALTER TABLE users ADD COLUMN is_cataloguer INTEGER NOT NULL DEFAULT 0;
