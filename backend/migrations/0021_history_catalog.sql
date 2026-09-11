CREATE TABLE public_market.catalog_versions(id uuid PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),source text NOT NULL,source_hash text NOT NULL);
CREATE TABLE public_market.instrument_lifecycles(
 market text NOT NULL CHECK(market IN ('usd_m','coin_m')),symbol text NOT NULL,
 first_seen_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),
 onboard_at timestamptz,delivery_at timestamptz,status text NOT NULL,archive_discovered boolean NOT NULL DEFAULT false,
 catalog_version uuid NOT NULL REFERENCES public_market.catalog_versions(id),PRIMARY KEY(market,symbol)
);
CREATE TABLE public_market.history_availability(
 market text NOT NULL,symbol text NOT NULL,timeframe text NOT NULL,source_key text NOT NULL,
 size_bytes bigint,status text NOT NULL CHECK(status IN ('discovered','verified','missing','checksum_failed')),
 checked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(market,symbol,timeframe,source_key)
);
CREATE TABLE public_market.source_revisions(
 source_key text NOT NULL,sha256 text NOT NULL CHECK(length(sha256)=64),size_bytes bigint NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_key,sha256)
);
CREATE TABLE public_market.coverage_segments(
 generation_id uuid PRIMARY KEY REFERENCES public_market.generations(id) ON DELETE CASCADE,
 market text NOT NULL,symbol text NOT NULL,timeframe text NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,
 actual_start timestamptz,actual_end timestamptz,status text NOT NULL CHECK(status IN ('complete','partial','unavailable','unverified')),
 checked_at timestamptz NOT NULL DEFAULT now(),CHECK(start_at<end_at)
);
CREATE INDEX coverage_segment_range ON public_market.coverage_segments(market,symbol,timeframe,start_at,end_at);
CREATE TABLE history_subscriptions(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),body jsonb NOT NULL,revision bigint NOT NULL DEFAULT 0,
 status text NOT NULL CHECK(status IN ('active','paused','cancelled','needs_attention')),
 next_run_at timestamptz NOT NULL DEFAULT now(),watermark timestamptz,cycle_end timestamptz,plan_no int NOT NULL DEFAULT 0,
 child_plan uuid,cycle bigint NOT NULL DEFAULT 0,last_error text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id)
);
CREATE TABLE history_subscription_plans(
 owner_id uuid NOT NULL,subscription_id uuid NOT NULL,cycle bigint NOT NULL,plan_no int NOT NULL,plan_id uuid NOT NULL,
 PRIMARY KEY(owner_id,subscription_id,cycle,plan_no),FOREIGN KEY(owner_id,subscription_id) REFERENCES history_subscriptions(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,plan_id) REFERENCES history_plans(owner_id,id)
);
