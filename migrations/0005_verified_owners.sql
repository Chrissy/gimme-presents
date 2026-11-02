ALTER TABLE owners ADD COLUMN email_key TEXT;
ALTER TABLE owners ADD COLUMN email_address TEXT;
ALTER TABLE owners ADD COLUMN email_verified_at TEXT;
CREATE UNIQUE INDEX owners_email ON owners(email_key) WHERE email_key IS NOT NULL;
ALTER TABLE sessions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1));

CREATE TABLE owner_usage (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id),
  list_day TEXT NOT NULL DEFAULT '',
  lists INTEGER NOT NULL DEFAULT 0,
  upload_day TEXT NOT NULL DEFAULT '',
  uploads INTEGER NOT NULL DEFAULT 0,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  reserved_bytes INTEGER NOT NULL DEFAULT 0
);
-- Existing references receive a conservative reservation; global accounting,
-- including unreferenced objects, remains unchanged.
INSERT INTO owner_usage (owner_id, reserved_bytes)
SELECT owners.id, COUNT(gifts.image_key) * 2097152 FROM owners
LEFT JOIN lists ON lists.owner_id = owners.id
LEFT JOIN gifts ON gifts.list_id = lists.id GROUP BY owners.id;
CREATE TRIGGER initialize_owner_usage AFTER INSERT ON owners BEGIN
  INSERT INTO owner_usage (owner_id) VALUES (NEW.id);
END;

-- A failed conditional write must abort its entire D1 batch, not just skip a row.
CREATE TABLE quota_assertion (ok INTEGER NOT NULL CHECK (ok = 1));

CREATE TRIGGER list_capacity BEFORE INSERT ON lists
WHEN (SELECT COUNT(*) FROM lists WHERE owner_id = NEW.owner_id) >= 100
BEGIN SELECT RAISE(ABORT, 'list_capacity'); END;
CREATE TRIGGER gift_capacity BEFORE INSERT ON gifts
WHEN (SELECT COUNT(*) FROM gifts WHERE list_id = NEW.list_id) >= 200
BEGIN SELECT RAISE(ABORT, 'gift_capacity'); END;
