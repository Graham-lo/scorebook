-- Explicit runtime cutover. Old records/results retain their historical model
-- identifiers, but old feature algorithms are no longer callable.
UPDATE public_market.features SET published=false WHERE model_id='candle-profile-v1';
UPDATE jobs SET status='cancelled',generation=generation+1,lease_owner=NULL,lease_until=NULL,error_code='retired_model_requires_v2_rebuild'
WHERE status IN('queued','running','retry_wait','awaiting_input','blocked_capability') AND ((kind='embed' AND body->>'model_id'='candle-profile-v1') OR (kind IN('history.index','history.plan') AND body->'models' ? 'candle-profile-v1'));
CREATE TABLE image_index_status(
 owner_id uuid NOT NULL,attachment_id uuid NOT NULL,model_id text NOT NULL,status text NOT NULL,reason text,
 checked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,attachment_id,model_id),
 FOREIGN KEY(owner_id,attachment_id) REFERENCES attachments(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE image_reindex_runs(id uuid PRIMARY KEY,owner_id uuid NOT NULL,after_id uuid,processed bigint NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(id) REFERENCES jobs(id) ON DELETE CASCADE DEFERRABLE);
WITH owners AS(SELECT DISTINCT owner_id FROM attachments WHERE kind='scene'),queued AS(
INSERT INTO jobs(id,owner_id,kind,dedupe_key,body,queue) SELECT gen_random_uuid(),owner_id,'images.reindex','chart-match-v2-cutover','{"protocol":"chart-match-v2"}','maintenance' FROM owners RETURNING id,owner_id)
INSERT INTO image_reindex_runs(id,owner_id) SELECT id,owner_id FROM queued;
