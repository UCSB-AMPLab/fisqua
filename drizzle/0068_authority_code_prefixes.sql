-- Authority code prefixes: the minting agency's own mark on the codes
-- it issues, stored per agency instead of hardcoded in the generator.
--
-- WHAT THIS CHANGES
-- -----------------
-- Entity and place codes have been minted as `ne-xxxxxx` and
-- `nl-xxxxxx` since the authority tables existed -- "neogranadina
-- entidad" and "neogranadina lugar" -- with the two prefixes written
-- into the code generator as a literal union. That was correct while
-- Neogranadina was the only institution cataloguing here. It is not
-- correct now: SBMAL, a Franciscan mission archive in California,
-- currently mints codes that assert its people and places are
-- Neogranadina's.
--
-- So the prefix becomes a per-agency setting: two nullable TEXT columns
-- on `federations` and the same two on `tenants`.
--
-- WHAT THE PREFIX MEANS, AND WHAT IT DOES NOT
-- -------------------------------------------
-- The prefix names the MAINTAINING AGENCY -- whoever did the
-- identifying, extracting and enriching that produced the record. An
-- authority code is a citable scholarly identifier, in the manner of a
-- Medici Archive Project number, not platform bookkeeping. Three facts
-- that look adjacent stay strictly separate:
--
--   who HOLDS the documents  -> irrelevant to the code entirely;
--   who may EDIT the record  -> `entities.tenant_id` / `places.tenant_id`
--                               (migration 0067), and MUTABLE: ownership
--                               can be transferred;
--   who MADE the record      -> the prefix, and NEVER mutable.
--
-- Which is why the prefix is STORED rather than derived. Deriving it
-- from `tenant_id` at render time would mean a later ownership transfer
-- silently rewrote the agency mark on every code that tenant holds --
-- making published citations false -- or would invite a reissue, which
-- breaks them outright. A code, once minted and published, is a
-- permanent fact about who made the record; the column records it and
-- nothing later edits it.
--
-- WHY BOTH TABLES
-- ---------------
-- A maintaining agency is a FEDERATION when the record lands in a shared
-- authority space (0067's `tenant_id IS NULL`), and a TENANT when the
-- record is that tenant's own (`tenant_id` set). Those are exactly the
-- two branches `requireAuthorityMint` already decides between, so the
-- mint reads the prefix from whichever row it just resolved as the
-- owner, with no second rule to keep in step.
--
-- WHY A LITERAL PAIR PER AGENCY, NOT A SLUG PLUS A TYPE LETTER
-- ------------------------------------------------------------
-- Neogranadina's two prefixes fuse the type letter into a two-letter
-- mnemonic (`ne`, `nl`); the general form keeps them separate
-- (`sbmal-e`, `sbmal-p`). Storing the finished prefix STRING covers both
-- shapes with no branching: the generator already builds
-- `${prefix}-${chars}`, so `ne` yields `ne-abc234` and `sbmal-e` yields
-- `sbmal-e-abc234` from the same line of code. A stored slug plus a
-- derived letter could not produce `ne`/`nl` at all without a
-- special case for one institution, permanently.
--
-- SEEDS
-- -----
-- Two rows, both idempotent, both matching identity literals in
-- app/lib/tenant.ts byte-for-byte:
--
--   the Neogranadina FEDERATION (b4462493-...) -> 'ne' / 'nl'. Its
--     authority space is shared (0067 set `shared_authorities_enabled`
--     to 1 for exactly this federation), so its mints resolve to the
--     federation row, and its ~78K existing codes keep their series.
--     Nothing about Neogranadina's codes changes -- not the existing
--     ones, and not the ones minted tomorrow.
--
--   the SBMAL TENANT (a0412263-...) -> 'sbmal-e' / 'sbmal-p'. SBMAL is a
--     member of the AMPL federation, whose `shared_authorities_enabled`
--     is 0, so its records are tenant-owned and its mints resolve to the
--     tenant row.
--
-- Every other federation and tenant is left NULL deliberately. NULL is
-- not a gap awaiting a backfill -- it means "this agency has not been
-- given a code prefix yet", and the mint path refuses to invent one: it
-- throws rather than fall back to another institution's mark, which is
-- the failure this whole migration exists to end. An agency gets its
-- pair when it is provisioned to catalogue authorities.
--
-- The 500 codes SBMAL has already minted under `ne-`/`nl-` are NOT
-- touched here. Re-coding existing rows is a data step, reviewed
-- separately -- `scripts/reissue-sbmal-authority-codes.ts` writes the
-- SQL for it and runs nothing.
--
-- SHAPE OF THE CHANGE
-- -------------------
-- Four ALTER TABLE ADD COLUMNs and two single-row UPDATEs, so wall time
-- is independent of table size (same reasoning as 0067's header: ADD
-- COLUMN rewrites nothing, issues no DELETE, and fires no cascade inside
-- D1's per-file transaction). Nullable with no default and no index, so
-- both columns stay droppable by the clean `DROP COLUMN` path.
--
-- Version: v0.7.0

ALTER TABLE federations ADD COLUMN entity_code_prefix TEXT;
ALTER TABLE federations ADD COLUMN place_code_prefix TEXT;
ALTER TABLE tenants ADD COLUMN entity_code_prefix TEXT;
ALTER TABLE tenants ADD COLUMN place_code_prefix TEXT;

-- The Neogranadina federation's shared authority space keeps the series
-- it has always minted. Idempotent, single row, no-op if re-run.
UPDATE federations
   SET entity_code_prefix = 'ne',
       place_code_prefix = 'nl'
 WHERE id = 'b4462493-6170-44f8-ae07-24666606d1f1';

-- SBMAL mints its own records (AMPL federation, sharing off), so its
-- prefixes live on the tenant row.
UPDATE tenants
   SET entity_code_prefix = 'sbmal-e',
       place_code_prefix = 'sbmal-p'
 WHERE id = 'a0412263-176c-45be-96c7-6421c9d2ad51';

-- Every other tenant that can mint an authority needs a pair too, or
-- its first mint after this migration throws. Both of these have
-- authorities enabled and sit in a sharing-off federation, so they
-- resolve to a TENANT prefix rather than a federation one:
--
--   ampl      -- an institutional tenant alongside Neogranadina
--   platform  -- the operator tenant; unlikely to mint, but the
--                capability is on, and a 500 on an unexpected path is
--                worse than an unused pair of columns
--
-- Tenants without the authorities capability (komuni) are left NULL
-- deliberately: they cannot reach a mint, and a NULL is the honest
-- record of "no agency configured" should that ever change.
UPDATE tenants
   SET entity_code_prefix = 'ampl-e',
       place_code_prefix = 'ampl-p'
 WHERE id = '8d235621-ae3b-4751-a241-20341efd6d3a';

UPDATE tenants
   SET entity_code_prefix = 'platform-e',
       place_code_prefix = 'platform-p'
 WHERE id = '0391baa2-0bab-44ae-ac08-9fa7eb7c6145';
