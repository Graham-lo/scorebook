INSERT INTO embedding_models(id,dimension,metadata) VALUES('candle-geometry-v2',192,'{"protocol":"chart-match-v2","preprocessing":"ohlc-geometry-resample64-v2","quality_validated":false}') ON CONFLICT DO NOTHING;
ALTER TABLE image_embeddings DROP CONSTRAINT private_embedding_dimension;
ALTER TABLE image_embeddings ADD CONSTRAINT private_embedding_dimension CHECK((model_id IN ('candle-profile-v1','candle-geometry-v2') AND vector_dims(embedding)=192) OR (model_id='dinov2-small-v1' AND vector_dims(embedding)=384));
ALTER TABLE public_market.features DROP CONSTRAINT features_check;
ALTER TABLE public_market.features ADD CONSTRAINT features_check CHECK((model_id IN ('candle-profile-v1','candle-geometry-v2') AND vector_dims(embedding)=192) OR (model_id='dinov2-small-v1' AND vector_dims(embedding)=384));
CREATE INDEX embeddings_geometry_hnsw ON image_embeddings USING hnsw ((embedding::vector(192)) vector_cosine_ops) WHERE model_id='candle-geometry-v2';
CREATE INDEX public_geometry_ann ON public_market.features USING hnsw ((embedding::vector(192)) vector_cosine_ops) WHERE model_id='candle-geometry-v2' AND published;
CREATE TABLE chart_analyses (
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,attachment_id uuid NOT NULL,region_hash text NOT NULL,body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(owner_id,id),UNIQUE(owner_id,attachment_id,region_hash),
 FOREIGN KEY(owner_id,attachment_id) REFERENCES attachments(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE chart_search_runs (
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,attachment_id uuid NOT NULL,body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,result jsonb,
 FOREIGN KEY(owner_id,attachment_id) REFERENCES attachments(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(id) REFERENCES jobs(id) ON DELETE CASCADE,UNIQUE(owner_id,id)
);
