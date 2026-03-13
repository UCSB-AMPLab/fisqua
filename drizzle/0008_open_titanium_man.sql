CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`parent_id` text,
	`author_id` text NOT NULL,
	`author_role` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `comment_entry_idx` ON `comments` (`entry_id`);--> statement-breakpoint
CREATE INDEX `comment_parent_idx` ON `comments` (`parent_id`);--> statement-breakpoint
CREATE TABLE `resegmentation_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`volume_id` text NOT NULL,
	`reported_by` text NOT NULL,
	`entry_id` text NOT NULL,
	`problem_type` text NOT NULL,
	`affected_entry_ids` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reported_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reseg_volume_idx` ON `resegmentation_flags` (`volume_id`);--> statement-breakpoint
ALTER TABLE `entries` ADD `description_status` text DEFAULT 'unassigned';--> statement-breakpoint
ALTER TABLE `entries` ADD `assigned_describer` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `entries` ADD `assigned_description_reviewer` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `entries` ADD `translated_title` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `resource_type` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `date_expression` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `date_start` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `date_end` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `extent` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `scope_content` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `language` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `description_notes` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `internal_notes` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `description_level` text DEFAULT 'item';