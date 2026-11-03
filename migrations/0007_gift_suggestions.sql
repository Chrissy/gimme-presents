ALTER TABLE owner_usage ADD COLUMN suggestion_day TEXT NOT NULL DEFAULT '';
ALTER TABLE owner_usage ADD COLUMN suggestions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE owner_usage ADD COLUMN suggestion_lease TEXT;
ALTER TABLE owner_usage ADD COLUMN suggestion_until INTEGER NOT NULL DEFAULT 0;

CREATE TABLE suggestion_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  day TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO suggestion_budget (id) VALUES (1);

CREATE TABLE gift_suggestions (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  url_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  result TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, url_hash)
);
CREATE INDEX gift_suggestions_expiry ON gift_suggestions(expires_at);
