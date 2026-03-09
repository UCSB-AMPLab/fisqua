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