-- Preserve the original image URL for provenance and rollback. Existing gifts
-- continue using it until explicitly migrated or given a different image URL.
ALTER TABLE gifts ADD COLUMN image_key TEXT;
