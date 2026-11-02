CREATE TABLE auth_requests (
  id TEXT PRIMARY KEY,
  client_key_hash TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  email_key TEXT NOT NULL,
  email_address TEXT NOT NULL,
  list_name TEXT,
  list_slug TEXT,
  return_list_id INTEGER,
  claim_owner_id TEXT,
  claim_session_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  owner_id TEXT REFERENCES owners(id)
);
CREATE INDEX auth_expiry ON auth_requests(expires_at);

CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY REFERENCES auth_requests(id) ON DELETE CASCADE,
  email_key TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  provider_id TEXT
);
CREATE INDEX email_pending ON email_outbox(status, next_attempt_at);
CREATE TABLE email_suppression (email_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE email_rate (
  key TEXT NOT NULL,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
CREATE INDEX email_rate_expiry ON email_rate(expires_at);
