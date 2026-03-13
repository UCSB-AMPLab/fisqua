PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`volume_id` text NOT NULL,
	`parent_id` text,
	`position` integer NOT NULL,
	`start_page` integer NOT NULL,
	`start_y` real DEFAULT 0 NOT NULL,
	`end_page` integer,
	`end_y` real,
	`type` text,
	`title` text,
	`modified_by` text,
	`description_status` text DEFAULT 'unassigned',
	`assigned_describer` text,
	`assigned_description_reviewer` text,
	`translated_title` text,
	`resource_type` text,
	`date_expression` text,
	`date_start` text,
	`date_end` text,
	`extent` text,
	`scope_content` text,
	`language` text,
	`description_notes` text,
	`internal_notes` text,
	`description_level` text DEFAULT 'item',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`modified_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_describer`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_description_reviewer`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_entries`("id", "volume_id", "parent_id", "position", "start_page", "start_y", "end_page", "end_y", "type", "title", "modified_by", "description_status", "assigned_describer", "assigned_description_reviewer", "translated_title", "resource_type", "date_expression", "date_start", "date_end", "extent", "scope_content", "language", "description_notes", "internal_notes", "description_level", "created_at", "updated_at") SELECT "id", "volume_id", "parent_id", "position", "start_page", "start_y", "end_page", "end_y", "type", "title", "modified_by", "description_status", "assigned_describer", "assigned_description_reviewer", "translated_title", "resource_type", "date_expression", "date_start", "date_end", "extent", "scope_content", "language", "description_notes", "internal_notes", "description_level", "created_at", "updated_at" FROM `entries`;--> statement-breakpoint
DROP TABLE `entries`;--> statement-breakpoint
ALTER TABLE `__new_entries` RENAME TO `entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `entry_volume_idx` ON `entries` (`volume_id`);--> statement-breakpoint
CREATE INDEX `entry_parent_idx` ON `entries` (`parent_id`);--> statement-breakpoint
CREATE INDEX `entry_volume_pos_idx` ON `entries` (`volume_id`,`position`);