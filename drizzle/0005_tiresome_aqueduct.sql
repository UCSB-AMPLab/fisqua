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