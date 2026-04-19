-- Rename `colonial_*` place columns to `historical_*`
--
-- The place authority covers administrative divisions across several
-- centuries of Colombian and wider neogranadino history, not only the
-- colonial period. "Colonial gobernacion" is misleading shorthand when
-- the same columns also hold Republican and pre-Hispanic administrative
-- labels. The rename to `historical_gobernacion`, `historical_partido`,
-- and `historical_region` keeps the data intact while removing the
-- implicit periodisation from the column names.
--
-- Version: v0.3.0

ALTER TABLE places RENAME COLUMN colonial_gobernacion TO historical_gobernacion;
ALTER TABLE places RENAME COLUMN colonial_partido TO historical_partido;
ALTER TABLE places RENAME COLUMN colonial_region TO historical_region;
