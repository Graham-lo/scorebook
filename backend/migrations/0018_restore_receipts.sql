CREATE TABLE restore_receipts(owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,manifest_sha256 text NOT NULL,completed_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX unpublished_features_age ON public_market.features(created_at,id) WHERE NOT published;
