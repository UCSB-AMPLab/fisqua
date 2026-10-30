-- Media pipeline: the digest of each page's master.
--
-- This migration records the digest of each pipeline page's master. A
-- volume registered from a capture manifest knows the SHA-256 of every
-- image it lists: the capture appliance computes it when the image is
-- shot, and the manifest carries it beside the image's object key.
-- `sha256` keeps that digest on the page row, for the object the page's
-- `master_key` names (the embedded preview where there is one,
-- otherwise the capture). The run spec carries it to the runner, which
-- computes the digest of the bytes it pulls and stops the volume with a
-- fixity error when they differ.
--
-- Nullable: volumes registered by other routes, and every item-PDF
-- page, carry no digest, and the runner checks nothing for them. When
-- set it is 64 lowercase hexadecimal characters, the form the run spec
-- accepts; the CHECK refuses upper case, so a digest compares byte for
-- byte. Every existing row is null.
--
-- Version: v0.8.0

ALTER TABLE pipeline_volume_pages ADD COLUMN sha256 TEXT
  CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'));
