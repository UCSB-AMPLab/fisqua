-- An index on a fonds' descriptions in id order.
--
-- The publish step that writes a fonds' descriptions file reads the
-- fonds in batches, each an id range of the fonds' published
-- descriptions, and reads the outline of the whole fonds in id order.
-- This index lets each of those reads seek `tenant_id = ? AND
-- root_description_id = ?` and walk only the fonds' own ids, so a
-- batch reads its own rows and no others. Without it a batch walked
-- either the whole tenant (through the tenant or root index) or the
-- primary-key range between its first and last id, which on random
-- UUID ids spans most of the table.
--
-- D1 keeps no planner statistics; with equality on two columns and a
-- range on the third, this index is the planner's choice for those
-- reads without them.
CREATE INDEX descriptions_tenant_root_id_idx ON descriptions (tenant_id, root_description_id, id);

-- @version v0.9.0
