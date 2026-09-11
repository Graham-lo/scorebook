CREATE TABLE chat_runs(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),credential_id uuid NOT NULL,permissions text[] NOT NULL,
 model_id text NOT NULL,body jsonb NOT NULL,status text NOT NULL DEFAULT 'queued',turn_no int NOT NULL DEFAULT 0,
 started_at timestamptz,deadline_at timestamptz,answer jsonb,error_code text,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),FOREIGN KEY(id) REFERENCES jobs(id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE chat_model_turns(
 owner_id uuid NOT NULL,run_id uuid NOT NULL,turn_no int NOT NULL,reply jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,run_id,turn_no),FOREIGN KEY(owner_id,run_id) REFERENCES chat_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE chat_tool_calls(
 owner_id uuid NOT NULL,run_id uuid NOT NULL,tool_call_id text NOT NULL,turn_no int NOT NULL,name text NOT NULL,arguments jsonb NOT NULL,
 arguments_sha256 text NOT NULL,status text NOT NULL DEFAULT 'prepared',result jsonb,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 PRIMARY KEY(owner_id,run_id,tool_call_id),FOREIGN KEY(owner_id,run_id) REFERENCES chat_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE chat_events(
 owner_id uuid NOT NULL,run_id uuid NOT NULL,sequence bigint GENERATED ALWAYS AS IDENTITY,event_type text NOT NULL,body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,run_id,sequence),
 FOREIGN KEY(owner_id,run_id) REFERENCES chat_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE chat_source_refs(
 owner_id uuid NOT NULL,run_id uuid NOT NULL,source_kind text NOT NULL,source_id uuid NOT NULL,source_version text NOT NULL,
 PRIMARY KEY(owner_id,run_id,source_kind,source_id,source_version),
 FOREIGN KEY(owner_id,run_id) REFERENCES chat_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE INDEX chat_source_lookup ON chat_source_refs(owner_id,source_kind,source_id);
CREATE FUNCTION invalidate_chat_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_ARGV[2]<>'source' THEN RETURN NULL; END IF;
 -- References, not UUID substrings, determine which derived answers become invalid.
 EXECUTE format('UPDATE chat_runs r SET status=''source_removed'',answer=NULL,error_code=''referenced_source_deleted'' WHERE EXISTS(SELECT 1 FROM chat_source_refs f JOIN changed c ON c.owner_id=f.owner_id AND c.%I=f.source_id WHERE f.owner_id=r.owner_id AND f.run_id=r.id AND f.source_kind=%L)',TG_ARGV[1],TG_ARGV[0]);
 UPDATE jobs j SET status='cancelled',generation=generation+1,lease_owner=NULL,lease_until=NULL,result=NULL,error_code='referenced_source_deleted' FROM chat_runs r WHERE r.owner_id=j.owner_id AND r.id=j.id AND r.status='source_removed' AND j.status<>'cancelled';
 DELETE FROM chat_model_turns t USING chat_runs r WHERE r.owner_id=t.owner_id AND r.id=t.run_id AND r.status='source_removed';
 DELETE FROM chat_tool_calls t USING chat_runs r WHERE r.owner_id=t.owner_id AND r.id=t.run_id AND r.status='source_removed';
 DELETE FROM chat_events e USING chat_runs r WHERE r.owner_id=e.owner_id AND r.id=e.run_id AND r.status='source_removed';
 RETURN NULL;
END $$;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM(VALUES('calls','call','id'),('reviews','review','id'),('outcomes','outcome','id'),('tags','tag','id'),('playbooks','playbook','id'),('playbook_events','playbook_event','id'),('episodes','episode','id'),('episode_links','episode_link','id'),('episode_reviews','episode_review','id'),('execution_links','execution_link','id'),('exchange_connections','execution_summary','id'),('set_runs','statistics','id'),('verdict_events','verdict','id'),('baseline_runs','baseline','id')) x(tab,kind,idcol) LOOP
 EXECUTE format('CREATE TRIGGER chat_source_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION invalidate_chat_sources(%L,%L,''source'')',r.tab,r.kind,r.idcol);
 END LOOP;
END $$;
