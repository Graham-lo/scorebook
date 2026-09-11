-- User directive 2026-09-09: raw market data and system charts are never persisted.
-- This removes only development-era market evidence; original words/images/reviews remain.
DROP TABLE market_snapshots;
ALTER TABLE manifests DISABLE TRIGGER immutable_update;
UPDATE manifests SET body=(body-'bars'-'trades'-'base'-'atr0'-'end_price') || '{"market_input_storage":"not_persisted","replay_verification":"unavailable_without_refetch"}'::jsonb;
ALTER TABLE manifests ENABLE TRIGGER immutable_update;
CREATE TABLE history_indexes(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),body jsonb NOT NULL,status text NOT NULL DEFAULT 'building',created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,coverage jsonb,UNIQUE(owner_id,id));
CREATE TABLE history_windows(id uuid PRIMARY KEY,owner_id uuid NOT NULL,index_id uuid NOT NULL,market text NOT NULL,symbol text NOT NULL,timeframe text NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,bars_count int NOT NULL,model_id text NOT NULL,embedding vector NOT NULL,input_hash text NOT NULL,render_version text NOT NULL,UNIQUE(owner_id,index_id,start_at,model_id),FOREIGN KEY(owner_id,index_id) REFERENCES history_indexes(owner_id,id) ON DELETE CASCADE);
CREATE INDEX history_filter ON history_windows(owner_id,market,symbol,timeframe,end_at);
CREATE INDEX history_profile_hnsw ON history_windows USING hnsw ((embedding::vector(192)) vector_cosine_ops) WHERE model_id='candle-profile-v1';
CREATE INDEX history_visual_hnsw ON history_windows USING hnsw ((embedding::vector(384)) vector_cosine_ops) WHERE model_id='dinov2-small-v1';
