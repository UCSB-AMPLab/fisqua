-- Capture QC: a delivery the review run sweep declined.
--
-- This migration records a capture delivery whose review run the sweep
-- declined. The scheduled sweep starts the review run of each
-- registered capture delivery that has none. A start it declines for a
-- reason of the delivery's own (its volume moved on or is restricted,
-- or the spec built from its pages fails the checks under its volume
-- entry) would be declined again on every tick, and enough of them
-- ahead of a healthy delivery would keep the sweep from ever reaching
-- it. `capture_deliveries.review_declined_at` records when the sweep
-- declined the delivery, in ms; the sweep leaves out deliveries that
-- carry it. A person's Prepare or Retry clears it before it starts the
-- run, so a declined delivery can always be tried again by hand. Null
-- for every existing row.
--
-- Version: v0.8.0

ALTER TABLE capture_deliveries ADD COLUMN review_declined_at INTEGER;
