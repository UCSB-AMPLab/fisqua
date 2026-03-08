-- Rename 'member' role to 'cataloguer' in existing data
UPDATE `project_members` SET `role` = 'cataloguer' WHERE `role` = 'member';
--> statement-breakpoint
CREATE TABLE `volume_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`volume_id` text NOT NULL,
	`position` integer NOT NULL,
	`image_url` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vp_volume_idx` ON `volume_pages` (`volume_id`);--> statement-breakpoint
CREATE INDEX `vp_volume_pos_idx` ON `volume_pages` (`volume_id`,`position`);--> statement-breakpoint
CREATE TABLE `volumes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`reference_code` text NOT NULL,
	`manifest_url` text NOT NULL,
	`page_count` integer NOT NULL,
	`status` text DEFAULT 'unstarted' NOT NULL,
	`assigned_to` text,
	`assigned_reviewer` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_to`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_reviewer`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vol_project_idx` ON `volumes` (`project_id`);--> statement-breakpoint
CREATE INDEX `vol_status_idx` ON `volumes` (`project_id`,`status`);