ALTER TABLE api_keys ADD COLUMN parent_id uuid REFERENCES api_keys(id);
CREATE INDEX api_keys_parent ON api_keys(parent_id);
