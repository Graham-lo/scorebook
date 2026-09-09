CREATE TABLE set_definitions(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),identity text NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),UNIQUE(owner_id,identity)
);
CREATE TABLE set_runs(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,definition_id uuid NOT NULL,status text NOT NULL DEFAULT 'queued',
 source_snapshot_at timestamptz,stats jsonb,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 UNIQUE(owner_id,id),FOREIGN KEY(id) REFERENCES jobs(id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,definition_id) REFERENCES set_definitions(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE set_sample_members(
 owner_id uuid NOT NULL,run_id uuid NOT NULL,ordinal bigint NOT NULL,call_id uuid NOT NULL,claim_no int NOT NULL,episode_id uuid,
 submitted_at timestamptz NOT NULL,signature text NOT NULL,state text NOT NULL,processing_state text,
 eligible boolean NOT NULL,representative boolean NOT NULL DEFAULT false,selected boolean NOT NULL,exclusion_reason text,body jsonb NOT NULL,
 PRIMARY KEY(owner_id,run_id,ordinal),UNIQUE(owner_id,run_id,call_id,claim_no),
 FOREIGN KEY(owner_id,run_id) REFERENCES set_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE INDEX set_sample_group ON set_sample_members(owner_id,run_id,signature,ordinal);
CREATE INDEX set_sample_source ON set_sample_members(owner_id,call_id);
CREATE TABLE verdict_requests(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,definition_id uuid NOT NULL,run_id uuid NOT NULL,signature text NOT NULL,
 threshold int NOT NULL,explicit_count int NOT NULL,status text NOT NULL DEFAULT 'pending',revision bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id),UNIQUE(owner_id,definition_id,signature,threshold),
 FOREIGN KEY(owner_id,definition_id) REFERENCES set_definitions(owner_id,id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,run_id) REFERENCES set_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE verdict_events(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,request_id uuid NOT NULL,decision text NOT NULL CHECK(decision IN ('evidence','observe','drop')),body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,request_id) REFERENCES verdict_requests(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE baseline_runs(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,statistics_run_id uuid NOT NULL,body jsonb NOT NULL,status text NOT NULL DEFAULT 'queued',
 next_ordinal bigint NOT NULL DEFAULT 0,next_day int NOT NULL DEFAULT 1,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id),
 FOREIGN KEY(id) REFERENCES jobs(id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,statistics_run_id) REFERENCES set_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE baseline_samples(
 owner_id uuid NOT NULL,run_id uuid NOT NULL,call_id uuid NOT NULL,claim_no int NOT NULL,at timestamptz NOT NULL,end_at timestamptz NOT NULL,
 result jsonb NOT NULL,input_sha256 text NOT NULL,PRIMARY KEY(owner_id,run_id,call_id,claim_no,at),
 FOREIGN KEY(owner_id,run_id) REFERENCES baseline_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE DEFERRABLE
);

CREATE OR REPLACE FUNCTION reference_ids(v jsonb) RETURNS TABLE(entity_type text,entity_id uuid) LANGUAGE sql IMMUTABLE AS $$
 WITH refs(kind,value) AS (
  SELECT 'call',v->>'call_id' UNION ALL SELECT 'attachment',v->>'attachment_id'
  UNION ALL SELECT 'job',v->>'statistics_run_id' UNION ALL SELECT 'job',v->>'baseline_run_id' UNION ALL SELECT 'job',v->>'search_run_id' UNION ALL SELECT 'job',v->>'job_id' UNION ALL SELECT 'session',v->>'session_id'
  UNION ALL SELECT 'set',v->>'set_snapshot_id' UNION ALL SELECT 'export',v->>'export_id'
  UNION ALL SELECT 'call',jsonb_array_elements_text(CASE WHEN jsonb_typeof(v->'call_ids')='array' THEN v->'call_ids' ELSE '[]' END)
  UNION ALL SELECT 'attachment',jsonb_array_elements_text(CASE WHEN jsonb_typeof(v->'attachments')='array' THEN v->'attachments' ELSE '[]' END)
  UNION ALL SELECT 'call',x->>'call_id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v->'items')='array' THEN v->'items' ELSE '[]' END) x
  UNION ALL SELECT 'attachment',x->>'attachment_id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v->'items')='array' THEN v->'items' ELSE '[]' END) x
 ) SELECT DISTINCT kind,value::uuid FROM refs WHERE value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
