ALTER TABLE public_market.history_availability ADD COLUMN actual_start timestamptz,ADD COLUMN actual_end timestamptz,ADD COLUMN sha256 text;
CREATE TABLE history_plan_scopes(
 owner_id uuid NOT NULL,plan_id uuid NOT NULL,symbol text NOT NULL,timeframe text NOT NULL,
 start_at timestamptz,end_at timestamptz,status text NOT NULL,proof jsonb NOT NULL,
 PRIMARY KEY(owner_id,plan_id,symbol,timeframe),FOREIGN KEY(owner_id,plan_id) REFERENCES history_plans(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
-- One active version of each exact time window. Frozen saved results retain IDs.
WITH ranked AS(SELECT market,timeframe,id,row_number() OVER(PARTITION BY market,symbol,timeframe,start_at,end_at,bars_count,model_id,render_version ORDER BY created_at DESC,id DESC) AS n FROM public_market.features WHERE published)
UPDATE public_market.features f SET published=false FROM ranked r WHERE f.market=r.market AND f.timeframe=r.timeframe AND f.id=r.id AND r.n>1;
CREATE UNIQUE INDEX public_window_active ON public_market.features(market,timeframe,symbol,start_at,end_at,bars_count,model_id,render_version) WHERE published;
ALTER TABLE public_market.generations ADD COLUMN supersedes uuid REFERENCES public_market.generations(id) ON DELETE SET NULL;
CREATE INDEX public_generation_request ON public_market.generations ((body->>'market'),(body->>'symbol'),(body->>'interval'),published_at DESC);
