-- Capture QC: a delivery with a rejected record holds its volume.
--
-- This migration records the rejected records of a capture delivery, so
-- that Fisqua can hold the volume. A volume goes to processing only when
-- every opening is approved (the Captua exchange contract). A record
-- `rejected` in a capture manifest is an opening with a retake outstanding
-- on the unit, whether Fisqua asked for the retake or the unit marked it:
-- its pages are not planned and it is not counted among the delivery's
-- `openings`, so neither the openings nor the decision set show it.
-- `capture_deliveries.rejected_records` is the number of the accepted
-- manifest's records with status `rejected`, written when the delivery is
-- registered, and 0 for a refusal. The hold holds a volume while its
-- registered delivery has any. It is a column for the reason `openings` is
-- one: records past 64 KiB are stored packed (`{"$gzip": ...}`), which SQL
-- cannot read.
--
-- Existing deliveries take the count from their records, which must be
-- plain JSON. A packed delivery's count cannot be read here, and no other
-- stored data gives it: `capture_images.record_status` is null on rows
-- written before 0100, and a rejected record may have no image at all.
-- A guessed 0 would release a volume with a retake outstanding, so the
-- migration refuses instead. Its first statements count the deliveries
-- whose records are not a plain JSON array into a guard table that
-- accepts only 0, and fail before anything else is changed when there is
-- any. No deployment had a packed delivery when this was written. If the
-- guard ever fails, an operator decompresses each such delivery's records
-- (`unpackJson` in `app/lib/capture/link.server.ts`), counts the records
-- `rejected`, adds the column as below, sets each of those deliveries'
-- counts by hand, runs the backfill for the rest, and records this
-- migration as applied. A refused delivery has no records and keeps 0.
--
-- Version: v0.8.0

CREATE TABLE capture_rejected_records_guard (packed INTEGER NOT NULL CHECK (packed = 0));
--> statement-breakpoint
INSERT INTO capture_rejected_records_guard (packed)
  SELECT COUNT(*) FROM capture_deliveries WHERE records IS NOT NULL AND json_type(records) <> 'array';
--> statement-breakpoint
DROP TABLE capture_rejected_records_guard;
--> statement-breakpoint
ALTER TABLE capture_deliveries ADD COLUMN rejected_records INTEGER NOT NULL DEFAULT 0
  CHECK (rejected_records >= 0);
--> statement-breakpoint
UPDATE capture_deliveries SET rejected_records = (
  SELECT COUNT(*) FROM json_each(capture_deliveries.records) r
  WHERE json_extract(r.value, '$.status') = 'rejected')
WHERE json_type(records) = 'array';
