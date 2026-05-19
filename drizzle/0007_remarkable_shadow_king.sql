-- Entry-level notes and reviewer comments
--
-- This migration adds two paired note fields to `entries` along with
-- their authorship and edit-time metadata. `note` is the cataloguer's
-- own working note against an entry — context, open questions,
-- transcription fragments; `reviewer_comment` is the reviewer's reply
-- when sending the entry back for revision. Each pairs with
-- `*_updated_by` (FK into `users`) and `*_updated_at` (epoch ms) so
-- the entry page can show provenance without joining the activity
-- log. All six columns are nullable; existing rows arrive without any
-- backfill.
--
-- Version: v0.3.0

ALTER TABLE `entries` ADD `note` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `note_updated_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `entries` ADD `note_updated_at` integer;--> statement-breakpoint
ALTER TABLE `entries` ADD `reviewer_comment` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `reviewer_comment_updated_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `entries` ADD `reviewer_comment_updated_at` integer;