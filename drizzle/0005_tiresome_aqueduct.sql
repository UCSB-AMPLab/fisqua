-- Activity log, modified-by stamps, last-active timestamps
--
-- This migration introduces `activity_log` and a handful of paired
-- columns on existing tables to give the project dashboard a real
-- audit trail. Each `activity_log` row records one event the system
-- cares about (an entry edited, a volume submitted for review, a
-- comment added) with the acting user, an optional project / volume
-- target, and a free-form `detail` field for event-specific payload.
-- Three indexes cover the dashboard's typical filters: by user, by
-- project, and most-recent-first.
--
-- Three ALTERs land next to the new table: `entries.modified_by`
-- captures who last edited a segmentation boundary,
-- `users.last_active_at` is touched on every authenticated request,
-- and `volumes.review_comment` carries the optional note a reviewer
-- leaves when sending a volume back for revision.
--
-- Version: v0.3.0

CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`volume_id` text,
	`event` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `al_user_idx` ON `activity_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `al_project_idx` ON `activity_log` (`project_id`);--> statement-breakpoint
CREATE INDEX `al_created_idx` ON `activity_log` (`created_at`);--> statement-breakpoint
ALTER TABLE `entries` ADD `modified_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `users` ADD `last_active_at` integer;--> statement-breakpoint
ALTER TABLE `volumes` ADD `review_comment` text;