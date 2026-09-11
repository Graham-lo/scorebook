CREATE TABLE provider_budgets(egress_id text NOT NULL,market text NOT NULL,window_start timestamptz NOT NULL DEFAULT date_trunc('minute',now()),used int NOT NULL DEFAULT 0,blocked_until timestamptz NOT NULL DEFAULT '1970-01-01 00:00:00+00',PRIMARY KEY(egress_id,market));
CREATE TABLE owner_queue_turns(owner_id uuid NOT NULL REFERENCES users(id),queue text NOT NULL,last_claim timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,queue));
-- Historical assessment queue states are migrated, not evaluated through old workers.
UPDATE jobs SET status='cancelled',error_code='retired_market_job' WHERE kind='market' AND status<>'succeeded';
