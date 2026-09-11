CREATE UNIQUE INDEX execution_link_single_successor ON execution_links(owner_id,supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX trade_import_page ON trade_imports(owner_id,created_at DESC,id DESC);
CREATE TABLE trigger_watches(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,call_id uuid NOT NULL,claim_no int NOT NULL,
 market text NOT NULL,symbol text NOT NULL,source_plan text NOT NULL CHECK(source_plan IN ('rest_continuous_v1','daily_archive_v1')),
 checkpoint jsonb NOT NULL,result jsonb,revision bigint NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'observing',
 updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id),
 FOREIGN KEY(id) REFERENCES jobs(id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE INDEX trigger_watch_active ON trigger_watches(market,symbol,updated_at) WHERE status='observing';
-- One checkpoint row per watch, overwritten atomically. Not a per-bar trace.
CREATE TABLE trigger_checkpoints(
 owner_id uuid NOT NULL,watch_id uuid NOT NULL,through_at timestamptz NOT NULL,source_sha256 text NOT NULL,revision bigint NOT NULL,
 PRIMARY KEY(owner_id,watch_id),FOREIGN KEY(owner_id,watch_id) REFERENCES trigger_watches(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE trigger_events(
 owner_id uuid NOT NULL,watch_id uuid NOT NULL,at timestamptz NOT NULL,price numeric NOT NULL,body jsonb NOT NULL,
 PRIMARY KEY(owner_id,watch_id),FOREIGN KEY(owner_id,watch_id) REFERENCES trigger_watches(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
-- Explicit cutover: seed all unsettled windows immediately, using the single
-- new assessment implementation; no dormant legacy due-only executor remains.
UPDATE jobs SET status='queued',run_after=now(),error_code=NULL WHERE kind IN ('assess','assess_revision') AND (status IN ('queued','retry_wait') OR error_code='conditional_provider_monitor_not_implemented');
