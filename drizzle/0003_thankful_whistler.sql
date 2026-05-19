-- Entries table: the segmentation tree inside each volume
--
-- This migration creates `entries`, the boundary model cataloguers
-- build over the pages of a volume to mark where each document, sub-
-- document, or grouping starts and ends. Each entry carries a page
-- range (`start_page`, `end_page`), an optional parent for nested
-- groupings, a `position` to fix order within its parent, and an
-- open-ended `type` plus `title` that later phases sharpen into a
-- bounded enum and structured fields.
--
-- The three indexes support the queries the viewer and the outline
-- run on every load: list entries for a volume, walk the children of
-- a parent, and read entries in display order.
--
-- Version: v0.3.0

CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`volume_id` text NOT NULL,
	`parent_id` text,
	`position` integer NOT NULL,
	`start_page` integer NOT NULL,
	`end_page` integer,
	`type` text,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entry_volume_idx` ON `entries` (`volume_id`);--> statement-breakpoint
CREATE INDEX `entry_parent_idx` ON `entries` (`parent_id`);--> statement-breakpoint
CREATE INDEX `entry_volume_pos_idx` ON `entries` (`volume_id`,`position`);