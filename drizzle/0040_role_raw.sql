-- Dual-track role: original Spanish preserved verbatim alongside the
-- normalised English `role` (CHECK-enforced).
--
-- This migration adds the `role_raw` companion column so the original
-- Spanish role string survives next to the normalised English `role`.
-- See production-data-audit.md exec summary item 8 for the source-value
-- inventory: mentioned/creator/sender/subject/defendant/recipient/
-- plaintiff/witness/scribe (English) coexist with Fiador/Apoderado/
-- Albacea/Reo/Heredero/Testigo/Heredera/Autor (Spanish) in Django.
--
-- The mapping table lives in scripts/lib/role-map.ts. Spanish→English
-- mappings populate `role` with the canonical enum value; the original
-- Spanish string lands in `role_raw` so the documentary-style original
-- survives next to the searchable normalised value.
--
-- No CHECK on `role_raw` — preserves whatever Django emits verbatim.
ALTER TABLE description_entities ADD COLUMN role_raw TEXT;
ALTER TABLE description_places ADD COLUMN role_raw TEXT;
