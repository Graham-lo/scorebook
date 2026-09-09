CREATE SCHEMA public_market;
REVOKE ALL ON SCHEMA public_market FROM PUBLIC;
CREATE TABLE public_market.generations(
 id uuid PRIMARY KEY,request_hash text NOT NULL UNIQUE,body jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',
 producer_job uuid,producer_lease uuid,created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,coverage jsonb
);
CREATE TABLE public_market.features(
 id uuid PRIMARY KEY,market text NOT NULL,symbol text NOT NULL,timeframe text NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,
 bars_count int NOT NULL,model_id text NOT NULL,embedding vector NOT NULL,input_hash text NOT NULL,render_version text NOT NULL,
 published boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(market,symbol,timeframe,start_at,end_at,bars_count,model_id,input_hash,render_version),
 CHECK((model_id='candle-profile-v1' AND vector_dims(embedding)=192) OR (model_id='dinov2-small-v1' AND vector_dims(embedding)=384))
);
CREATE TABLE public_market.generation_features(generation_id uuid NOT NULL REFERENCES public_market.generations(id) ON DELETE CASCADE,feature_id uuid NOT NULL REFERENCES public_market.features(id),PRIMARY KEY(generation_id,feature_id));
CREATE INDEX public_feature_generations ON public_market.generation_features(feature_id,generation_id);
CREATE INDEX public_profile_ann ON public_market.features USING hnsw ((embedding::vector(192)) vector_cosine_ops) WHERE model_id='candle-profile-v1' AND published;
CREATE INDEX public_visual_ann ON public_market.features USING hnsw ((embedding::vector(384)) vector_cosine_ops) WHERE model_id='dinov2-small-v1' AND published;
CREATE INDEX public_feature_filter ON public_market.features(market,symbol,timeframe,end_at) WHERE published;
ALTER TABLE history_indexes ADD COLUMN generation_id uuid REFERENCES public_market.generations(id);
-- Migrate metadata-derived features once; there is no legacy runtime reader.
INSERT INTO public_market.generations(id,request_hash,body,status,published_at,coverage)
 SELECT DISTINCT ON(md5(body::text)) md5(body::text)::uuid,md5(body::text),body,
 CASE WHEN status='ready' THEN 'ready' ELSE 'pending' END,completed_at,coverage-'index_id'
 FROM history_indexes ORDER BY md5(body::text),completed_at DESC NULLS LAST,id;
UPDATE history_indexes SET generation_id=md5(body::text)::uuid;
INSERT INTO public_market.features(id,market,symbol,timeframe,start_at,end_at,bars_count,model_id,embedding,input_hash,render_version,published)
 SELECT md5(jsonb_build_array(w.market,w.symbol,w.timeframe,w.start_at,w.end_at,w.bars_count,w.model_id,w.input_hash,w.render_version)::text)::uuid,
 w.market,w.symbol,w.timeframe,w.start_at,w.end_at,w.bars_count,w.model_id,w.embedding,w.input_hash,w.render_version,bool_or(i.status='ready') OVER(PARTITION BY w.market,w.symbol,w.timeframe,w.start_at,w.end_at,w.bars_count,w.model_id,w.input_hash,w.render_version)
 FROM history_windows w JOIN history_indexes i ON i.owner_id=w.owner_id AND i.id=w.index_id ON CONFLICT DO NOTHING;
INSERT INTO public_market.generation_features SELECT i.generation_id,md5(jsonb_build_array(w.market,w.symbol,w.timeframe,w.start_at,w.end_at,w.bars_count,w.model_id,w.input_hash,w.render_version)::text)::uuid
 FROM history_windows w JOIN history_indexes i ON i.owner_id=w.owner_id AND i.id=w.index_id ON CONFLICT DO NOTHING;
DROP TABLE history_windows;
ALTER TABLE image_embeddings ADD CONSTRAINT private_embedding_dimension CHECK((model_id='candle-profile-v1' AND vector_dims(embedding)=192) OR (model_id='dinov2-small-v1' AND vector_dims(embedding)=384));
-- A separate login can be granted SELECT on this schema without access to private evidence.
REVOKE ALL ON ALL TABLES IN SCHEMA public_market FROM PUBLIC;
