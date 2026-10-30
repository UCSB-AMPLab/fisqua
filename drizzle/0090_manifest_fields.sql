-- Manifest settings for repositories and tenants.
--
-- This migration adds manifest settings to repositories and tenants. A
-- pipeline manifest takes its rights and attribution from the volume's
-- repository, and its public site, provider and METS location from the
-- tenant. These columns hold those values. Each one is set by the
-- repository or tenant on its own form; nothing is defaulted.
--
-- On `repositories`: `manifest_rights` is the rights URI a manifest
-- carries, and `attribution_en` and `attribution_es` are the two
-- languages of its required statement. A repository without rights has
-- its volumes refused at dispatch; a repository with one attribution
-- language and not the other is refused too.
--
-- On `tenants`: `public_site_url` and `public_site_name` name the site
-- that shows the tenant's descriptions (each manifest's homepage and the
-- provider's homepage); `provider_name` and `provider_url` name the
-- provider; `mets_base_url` is where each description's METS file is
-- published, linked from the manifest's `seeAlso`. A tenant with none of
-- them gets manifests without a homepage, provider or METS link.
--
-- Separate nullable columns, not one JSON column, so each value can be
-- read, validated and cleared on its own. Every existing row is null.
--
-- Version: v0.8.0

ALTER TABLE repositories ADD COLUMN manifest_rights TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN attribution_en TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN attribution_es TEXT;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN public_site_url TEXT;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN public_site_name TEXT;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN provider_name TEXT;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN provider_url TEXT;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN mets_base_url TEXT;
