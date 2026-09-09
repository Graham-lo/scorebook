CREATE INDEX reviews_call_time ON reviews(owner_id,call_id,created_at,id);
CREATE INDEX episode_links_call_latest ON episode_links(owner_id,call_id,created_at DESC,id DESC);
CREATE INDEX episode_links_episode_time ON episode_links(owner_id,episode_id,created_at,id);
CREATE INDEX events_call_sequence ON events(owner_id,call_id,sequence);
CREATE INDEX manifests_call ON manifests(owner_id,call_id);
CREATE INDEX playbook_events_time ON playbook_events(owner_id,playbook_id,created_at,id);
CREATE INDEX call_attachments_image ON call_attachments(owner_id,attachment_id,call_id);
CREATE INDEX reviews_note_search ON reviews USING gin((body->>'note') gin_trgm_ops);

ALTER TABLE api_keys ADD COLUMN permissions text[] NOT NULL DEFAULT ARRAY['knowledge.read','search.compute','search.save','history.build','records.write','maintenance'];
UPDATE api_keys SET permissions=ARRAY['knowledge.read','search.compute'] WHERE scope='read_only';
ALTER TABLE api_keys DROP COLUMN scope;
ALTER TABLE api_keys ADD COLUMN expires_at timestamptz;
ALTER TABLE api_keys ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE api_keys ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
ALTER TABLE similarity_sessions ADD COLUMN expires_at timestamptz DEFAULT (now()+interval '7 days');
ALTER TABLE similarity_sessions ADD COLUMN saved boolean NOT NULL DEFAULT false;
CREATE INDEX search_sessions_expiry ON similarity_sessions(expires_at,id) WHERE NOT saved;
CREATE INDEX query_attachment_expiry ON attachments(uploaded_at,id) WHERE kind='query';
CREATE TABLE set_members(owner_id uuid NOT NULL,set_id uuid NOT NULL,call_id uuid NOT NULL,
 PRIMARY KEY(owner_id,set_id,call_id),FOREIGN KEY(owner_id,set_id) REFERENCES set_snapshots(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE);
CREATE INDEX set_members_call ON set_members(owner_id,call_id,set_id);
INSERT INTO set_members SELECT s.owner_id,s.id,c.id FROM set_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.members) m JOIN calls c ON c.owner_id=s.owner_id AND c.id::text=m->>'id' ON CONFLICT DO NOTHING;
CREATE TABLE search_result_refs(owner_id uuid NOT NULL,session_id uuid NOT NULL,entity_type text NOT NULL CHECK(entity_type IN ('call','attachment')),entity_id uuid NOT NULL,
 PRIMARY KEY(owner_id,session_id,entity_type,entity_id),FOREIGN KEY(owner_id,session_id) REFERENCES similarity_sessions(owner_id,id) ON DELETE CASCADE);
CREATE INDEX search_refs_entity ON search_result_refs(owner_id,entity_type,entity_id,session_id);
CREATE TABLE job_targets(owner_id uuid NOT NULL,job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,entity_type text NOT NULL,entity_id uuid NOT NULL,PRIMARY KEY(owner_id,job_id,entity_type,entity_id));
CREATE INDEX job_targets_entity ON job_targets(owner_id,entity_type,entity_id,job_id);
CREATE TABLE export_refs(owner_id uuid NOT NULL,export_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,entity_type text NOT NULL,entity_id uuid NOT NULL,PRIMARY KEY(owner_id,export_id,entity_type,entity_id));
CREATE INDEX export_refs_entity ON export_refs(owner_id,entity_type,entity_id,export_id);
CREATE TABLE request_refs(owner_id uuid NOT NULL,operation text NOT NULL,key text NOT NULL,entity_type text NOT NULL,entity_id uuid NOT NULL,
 PRIMARY KEY(owner_id,operation,key,entity_type,entity_id),FOREIGN KEY(owner_id,operation,key) REFERENCES requests(owner_id,operation,key) ON DELETE CASCADE);
CREATE INDEX request_refs_entity ON request_refs(owner_id,entity_type,entity_id);
-- Explicit structural references, never UUID substring matching of user prose.
CREATE FUNCTION reference_ids(v jsonb) RETURNS TABLE(entity_type text,entity_id uuid) LANGUAGE sql IMMUTABLE AS $$
 WITH refs(kind,value) AS (
  SELECT 'call',v->>'call_id' UNION ALL SELECT 'attachment',v->>'attachment_id'
  UNION ALL SELECT 'job',v->>'job_id' UNION ALL SELECT 'session',v->>'session_id'
  UNION ALL SELECT 'set',v->>'set_snapshot_id' UNION ALL SELECT 'export',v->>'export_id'
  UNION ALL SELECT 'call',jsonb_array_elements_text(CASE WHEN jsonb_typeof(v->'call_ids')='array' THEN v->'call_ids' ELSE '[]' END)
  UNION ALL SELECT 'attachment',jsonb_array_elements_text(CASE WHEN jsonb_typeof(v->'attachments')='array' THEN v->'attachments' ELSE '[]' END)
  UNION ALL SELECT 'call',x->>'call_id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v->'items')='array' THEN v->'items' ELSE '[]' END) x
  UNION ALL SELECT 'attachment',x->>'attachment_id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v->'items')='array' THEN v->'items' ELSE '[]' END) x
 ) SELECT DISTINCT kind,value::uuid FROM refs WHERE value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
INSERT INTO search_result_refs SELECT s.owner_id,s.id,r.* FROM similarity_sessions s CROSS JOIN LATERAL reference_ids(s.body||s.results) r WHERE r.entity_type IN ('call','attachment') ON CONFLICT DO NOTHING;
INSERT INTO job_targets SELECT j.owner_id,j.id,r.* FROM jobs j CROSS JOIN LATERAL reference_ids(j.body) r ON CONFLICT DO NOTHING;
INSERT INTO request_refs SELECT q.owner_id,q.operation,q.key,r.* FROM requests q CROSS JOIN LATERAL reference_ids(q.response) r ON CONFLICT DO NOTHING;
INSERT INTO request_refs SELECT q.owner_id,q.operation,q.key,'call',c.id FROM requests q JOIN calls c ON c.owner_id=q.owner_id AND c.id::text=q.response->>'id' WHERE q.operation='calls.create' ON CONFLICT DO NOTHING;
-- Old export snapshots are inventoried from their creation cutoff; new exports pin exact snapshot members.
INSERT INTO export_refs SELECT j.owner_id,j.id,'call',c.id FROM jobs j JOIN calls c ON c.owner_id=j.owner_id AND c.submitted_at<=j.created_at WHERE j.kind='export' ON CONFLICT DO NOTHING;

CREATE TABLE review_drafts(owner_id uuid NOT NULL,call_id uuid NOT NULL,revision bigint NOT NULL DEFAULT 1,body jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,call_id),FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE);
CREATE TABLE review_preferences(owner_id uuid NOT NULL,call_id uuid NOT NULL,snoozed_until timestamptz,revision bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,call_id),FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE);
-- Outcomes capture which completed review last considered them without rewriting original evidence.
CREATE TABLE review_outcome_refs(owner_id uuid NOT NULL,review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,outcome_id uuid NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,PRIMARY KEY(owner_id,review_id,outcome_id));
