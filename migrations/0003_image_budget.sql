-- Reserve capacity before any R2 operation. Never decrement on deletion or
-- failure: superseded, orphaned, and uncertain writes can still occupy R2.
CREATE TABLE image_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  upload_day TEXT NOT NULL DEFAULT '',
  uploads INTEGER NOT NULL DEFAULT 0,
  read_day TEXT NOT NULL DEFAULT '',
  reads INTEGER NOT NULL DEFAULT 0
);
INSERT INTO image_budget (id) VALUES (1);
