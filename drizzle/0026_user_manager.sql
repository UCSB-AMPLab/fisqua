-- User manager role flag
--
-- Adds `is_user_manager` to `users` so that a subset of staff can
-- handle day-to-day account administration -- inviting new users,
-- editing profiles, assigning accounts to projects -- without
-- holding full superadmin rights over the publish pipeline or
-- schema. Additive and defaults to 0, so existing accounts keep
-- their current permissions.
--
-- Version: v0.3.0

ALTER TABLE users ADD COLUMN is_user_manager INTEGER NOT NULL DEFAULT 0;
