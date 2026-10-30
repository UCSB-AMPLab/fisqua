-- Capture QC: a rejection names the image to retake.
--
-- This migration lets a capture QC rejection name the image to retake.
-- An opening is one Captua record, with one image (role `single`) or
-- two (roles `left` and `right`). The Captua exchange contract has a
-- rejection of a two-image opening say which image needs retaking, as
-- `side`: `left`, `right` or `both`. It is a code, so the reviewer and
-- the unit's operator each read it in their own language. A retake of a
-- two-camera opening still recaptures both images; `side` tells the
-- operator what to fix and does not limit what is reshot.
--
-- `capture_qc_decisions.side` holds it. It is null for an approval and
-- for a rejection of a one-image opening, and the decisions route gives
-- it for every rejection of a two-image opening. A rejection recorded
-- before this migration keeps null, which the unit reads as a rejection
-- of the whole opening. Two column CHECKs
-- hold the rule in the database: the value is one of the three, and it
-- is null unless the decision is `rejected`. SQLite accepts a column
-- CHECK that reads another column of the row, and tests it against the
-- existing rows when the column is added; every existing row takes
-- null, which passes both. Whether the opening has two images is a fact
-- of `capture_images`, which a CHECK cannot read, so the route enforces
-- that part. Approvals carried across a retake (`carry.server.ts`)
-- write null.
--
-- Version: v0.8.0

ALTER TABLE capture_qc_decisions ADD COLUMN side TEXT
  CHECK (side IS NULL OR side IN ('left','right','both'))
  CHECK (side IS NULL OR decision = 'rejected');
