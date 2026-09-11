ALTER TABLE api_keys ADD COLUMN scope text NOT NULL DEFAULT 'full' CHECK(scope IN ('full','read_only'));
CREATE TABLE deletion_requests(id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), call_id uuid NOT NULL, expected_revision bigint NOT NULL, token_hash text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz, UNIQUE(owner_id,id));
