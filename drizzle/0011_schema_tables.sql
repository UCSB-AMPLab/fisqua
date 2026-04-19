-- Archival description schema: core tables
--
-- This migration lays down the archival backbone of the app: descriptions
-- (ISAD(G) records arranged as an adjacency-list tree), the repositories
-- that hold them, the controlled authority records for entities (people,
-- corporate bodies) and places, and the two join tables that link
-- descriptions to the entities and places they mention.
--
-- The `descriptions` table carries every ISAD(G) field a cataloguer can
-- fill in (title, reference code, scope and content, extent, dates,
-- languages, access conditions, and the rest), plus denormalised tree
-- metadata -- root_description_id, depth, child_count, path_cache --
-- that keeps hierarchy rendering fast without walking the parent chain
-- on every request. Entities follow ISAAR(CPF) conventions (display
-- name, sort name, name variants, dates of existence, history) and are
-- linked to Wikidata and VIAF where known. Places carry place-type,
-- historical administrative-division fields, coordinates, and links
-- to Wikidata, Getty TGN, and WHG.
--
-- Join rows carry their own role (creator, subject, recipient, etc.)
-- and a sequence for ordering when a single description lists several
-- entities in the same role. Unique indexes on (description_id,
-- entity_id, role) and (description_id, place_id, role) prevent
-- duplicate links at the role level while still allowing the same
-- entity or place to appear in different roles on the same record.
--
-- Version: v0.3.0

CREATE TABLE `description_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`description_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`role` text NOT NULL,
	`role_note` text,
	`sequence` integer DEFAULT 0 NOT NULL,
	`honorific` text,
	`function` text,
	`name_as_recorded` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`description_id`) REFERENCES `descriptions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `de_desc_idx` ON `description_entities` (`description_id`);--> statement-breakpoint
CREATE INDEX `de_entity_role_idx` ON `description_entities` (`entity_id`,`role`);--> statement-breakpoint
CREATE UNIQUE INDEX `de_unique_idx` ON `description_entities` (`description_id`,`entity_id`,`role`);--> statement-breakpoint
CREATE TABLE `description_places` (
	`id` text PRIMARY KEY NOT NULL,
	`description_id` text NOT NULL,
	`place_id` text NOT NULL,
	`role` text NOT NULL,
	`role_note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`description_id`) REFERENCES `descriptions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`place_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `dp_desc_idx` ON `description_places` (`description_id`);--> statement-breakpoint
CREATE INDEX `dp_place_role_idx` ON `description_places` (`place_id`,`role`);--> statement-breakpoint
CREATE UNIQUE INDEX `dp_unique_idx` ON `description_places` (`description_id`,`place_id`,`role`);--> statement-breakpoint
CREATE TABLE `descriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`parent_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`root_description_id` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`child_count` integer DEFAULT 0 NOT NULL,
	`path_cache` text DEFAULT '',
	`description_level` text NOT NULL,
	`resource_type` text,
	`genre` text DEFAULT '[]',
	`reference_code` text NOT NULL,
	`local_identifier` text NOT NULL,
	`title` text NOT NULL,
	`translated_title` text,
	`uniform_title` text,
	`date_expression` text,
	`date_start` text,
	`date_end` text,
	`date_certainty` text,
	`extent` text,
	`dimensions` text,
	`medium` text,
	`imprint` text,
	`edition_statement` text,
	`series_statement` text,
	`volume_number` text,
	`issue_number` text,
	`pages` text,
	`provenance` text,
	`scope_content` text,
	`ocr_text` text DEFAULT '',
	`arrangement` text,
	`access_conditions` text,
	`reproduction_conditions` text,
	`language` text,
	`location_of_originals` text,
	`location_of_copies` text,
	`related_materials` text,
	`finding_aids` text,
	`section_title` text,
	`notes` text,
	`internal_notes` text,
	`creator_display` text,
	`place_display` text,
	`iiif_manifest_url` text,
	`has_digital` integer DEFAULT false,
	`is_published` integer DEFAULT true,
	`created_by` text,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `desc_parent_pos_idx` ON `descriptions` (`parent_id`,`position`);--> statement-breakpoint
CREATE INDEX `desc_root_idx` ON `descriptions` (`root_description_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `desc_ref_code_idx` ON `descriptions` (`reference_code`);--> statement-breakpoint
CREATE INDEX `desc_repo_idx` ON `descriptions` (`repository_id`);--> statement-breakpoint
CREATE INDEX `desc_local_id_idx` ON `descriptions` (`local_identifier`);--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_code` text,
	`display_name` text NOT NULL,
	`sort_name` text NOT NULL,
	`surname` text,
	`given_name` text,
	`entity_type` text NOT NULL,
	`honorific` text,
	`primary_function` text,
	`name_variants` text DEFAULT '[]',
	`dates_of_existence` text,
	`date_start` text,
	`date_end` text,
	`history` text,
	`legal_status` text,
	`functions` text,
	`sources` text,
	`merged_into` text,
	`wikidata_id` text,
	`viaf_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_code_idx` ON `entities` (`entity_code`);--> statement-breakpoint
CREATE INDEX `entity_sort_name_idx` ON `entities` (`sort_name`);--> statement-breakpoint
CREATE INDEX `entity_wikidata_idx` ON `entities` (`wikidata_id`);--> statement-breakpoint
CREATE TABLE `entity_functions` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`honorific` text,
	`function` text NOT NULL,
	`date_start` text,
	`date_end` text,
	`date_note` text,
	`certainty` text DEFAULT 'probable',
	`source` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ef_entity_idx` ON `entity_functions` (`entity_id`);--> statement-breakpoint
CREATE TABLE `places` (
	`id` text PRIMARY KEY NOT NULL,
	`place_code` text,
	`label` text NOT NULL,
	`display_name` text NOT NULL,
	`place_type` text,
	`name_variants` text DEFAULT '[]',
	`parent_id` text,
	`latitude` real,
	`longitude` real,
	`coordinate_precision` text,
	`colonial_gobernacion` text,
	`colonial_partido` text,
	`colonial_region` text,
	`country_code` text,
	`admin_level_1` text,
	`admin_level_2` text,
	`needs_geocoding` integer DEFAULT true,
	`merged_into` text,
	`tgn_id` text,
	`hgis_id` text,
	`whg_id` text,
	`wikidata_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `place_code_idx` ON `places` (`place_code`);--> statement-breakpoint
CREATE INDEX `place_label_idx` ON `places` (`label`);--> statement-breakpoint
CREATE INDEX `place_tgn_idx` ON `places` (`tgn_id`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`short_name` text,
	`country_code` text DEFAULT 'COL',
	`country` text,
	`city` text,
	`address` text,
	`website` text,
	`notes` text,
	`enabled` integer DEFAULT true,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_code_idx` ON `repositories` (`code`);
