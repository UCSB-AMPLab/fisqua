ALTER TABLE `entries` ADD `note` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `note_updated_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `entries` ADD `note_updated_at` integer;--> statement-breakpoint
ALTER TABLE `entries` ADD `reviewer_comment` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `reviewer_comment_updated_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `entries` ADD `reviewer_comment_updated_at` integer;