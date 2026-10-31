-- Bound anonymous owner/session creation without adding a login requirement.
CREATE TABLE list_creation_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  day TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO list_creation_budget (id) VALUES (1);
-- Daily reservations are separate from retained lifetime storage capacity.
ALTER TABLE image_budget ADD COLUMN upload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (upload_bytes >= 0);

