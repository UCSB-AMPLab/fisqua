-- Sub-page boundary coordinates on entries
--
-- This migration adds two `real` columns to `entries` so a boundary
-- can sit mid-page rather than only on a page break. `start_y` is the
-- normalised (0–1) vertical position on `start_page` where the entry
-- begins; `end_y` is the equivalent position on `end_page`. Existing
-- rows fall back to `start_y = 0` and `end_y` NULL, which corresponds
-- to the previous "whole-page" semantics. The viewer's boundary
-- markers and the segmentation reducer were updated in lockstep.
--
-- Version: v0.3.0

ALTER TABLE `entries` ADD `start_y` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entries` ADD `end_y` real;