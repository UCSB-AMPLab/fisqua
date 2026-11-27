-- A workspace's default interface language.
--
-- This migration adds `default_locale` to `tenants`: the language a
-- workspace's pages are shown in to a visitor who has not chosen one.
-- The server picks the language from `?lang=`, then the `lang` cookie,
-- then this column, then the browser's Accept-Language, then Spanish.
-- NULL means the workspace has no default, and the browser's language
-- decides. The column takes `en` or `es`, the two interface languages.
--
-- The AHR and Neogranadina workspaces take Spanish, selected by slug;
-- every other row stays NULL. The platform host has no default.
--
-- Version: v0.9.0
ALTER TABLE tenants ADD COLUMN default_locale TEXT CHECK (default_locale IS NULL OR default_locale IN ('en','es'));
--> statement-breakpoint
UPDATE tenants SET default_locale = 'es' WHERE slug IN ('ahr','neogranadina');
