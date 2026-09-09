-- One atomic physical migration. No runtime old-table reader or fallback.
ALTER TABLE public_market.features RENAME TO features_pre_partition;
CREATE TABLE public_market.feature_locator(
 id uuid PRIMARY KEY,market text NOT NULL,timeframe text NOT NULL,UNIQUE(id,market,timeframe)
);
CREATE TABLE public_market.features(
 id uuid NOT NULL,market text NOT NULL,symbol text NOT NULL,timeframe text NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,
 bars_count int NOT NULL,model_id text NOT NULL,embedding vector NOT NULL,input_hash text NOT NULL,render_version text NOT NULL,
 published boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(market,timeframe,id),
 UNIQUE(market,symbol,timeframe,start_at,end_at,bars_count,model_id,input_hash,render_version),
 CHECK((model_id IN ('candle-profile-v1','candle-geometry-v2') AND vector_dims(embedding)=192) OR (model_id='dinov2-small-v1' AND vector_dims(embedding)=384)),
 FOREIGN KEY(id,market,timeframe) REFERENCES public_market.feature_locator(id,market,timeframe) DEFERRABLE INITIALLY DEFERRED
) PARTITION BY LIST(market);
DO $$ DECLARE m text; tf text; parent text; child text; BEGIN
 FOREACH m IN ARRAY ARRAY['usd_m','coin_m'] LOOP
  parent:='features_'||m;
  EXECUTE format('CREATE TABLE public_market.%I PARTITION OF public_market.features FOR VALUES IN (%L) PARTITION BY LIST(timeframe)',parent,m);
  FOREACH tf IN ARRAY ARRAY['1m','5m','15m','1h','4h','1d'] LOOP
   child:=parent||'_'||tf;
   EXECUTE format('CREATE TABLE public_market.%I PARTITION OF public_market.%I FOR VALUES IN (%L)',child,parent,tf);
  END LOOP;
 END LOOP;
END $$;
INSERT INTO public_market.feature_locator SELECT id,market,timeframe FROM public_market.features_pre_partition;
INSERT INTO public_market.features SELECT * FROM public_market.features_pre_partition;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE public_market.generation_features DROP CONSTRAINT generation_features_feature_id_fkey;
ALTER TABLE public_market.generation_features ADD CONSTRAINT generation_features_feature_id_fkey FOREIGN KEY(feature_id) REFERENCES public_market.feature_locator(id);
ALTER TABLE public_market.feature_locator ADD CONSTRAINT locator_feature_fkey FOREIGN KEY(market,timeframe,id) REFERENCES public_market.features(market,timeframe,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
DROP TABLE public_market.features_pre_partition;
CREATE INDEX public_profile_ann ON public_market.features USING hnsw ((embedding::vector(192)) vector_cosine_ops) WHERE model_id='candle-profile-v1' AND published;
CREATE INDEX public_visual_ann ON public_market.features USING hnsw ((embedding::vector(384)) vector_cosine_ops) WHERE model_id='dinov2-small-v1' AND published;
CREATE INDEX public_geometry_ann ON public_market.features USING hnsw ((embedding::vector(192)) vector_cosine_ops) WHERE model_id='candle-geometry-v2' AND published;
CREATE INDEX public_feature_filter ON public_market.features(market,symbol,timeframe,end_at) WHERE published;
REVOKE ALL ON ALL TABLES IN SCHEMA public_market FROM PUBLIC;
