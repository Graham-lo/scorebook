CREATE SEQUENCE knowledge_mutation;
CREATE TABLE knowledge_dirty(
 owner_id uuid NOT NULL REFERENCES users(id),source_kind text NOT NULL,source_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT nextval('knowledge_mutation'),changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,source_kind,source_id)
);
CREATE TABLE knowledge_documents(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),source_kind text NOT NULL,source_id uuid NOT NULL,
 source_version text NOT NULL,occurred_at timestamptz NOT NULL,content text NOT NULL,source_uri text NOT NULL,
 indexed_revision bigint NOT NULL,indexed_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id),UNIQUE(owner_id,source_kind,source_id)
);
CREATE TABLE knowledge_chunks(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,document_id uuid NOT NULL,ordinal int NOT NULL,start_byte int NOT NULL,end_byte int NOT NULL,
 content text NOT NULL,content_sha256 text NOT NULL,UNIQUE(owner_id,id),UNIQUE(owner_id,document_id,ordinal),
 FOREIGN KEY(owner_id,document_id) REFERENCES knowledge_documents(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE INDEX knowledge_chunk_literal ON knowledge_chunks USING gin(content gin_trgm_ops);
CREATE TABLE knowledge_embeddings(
 owner_id uuid NOT NULL,chunk_id uuid NOT NULL,model_id text NOT NULL CHECK(model_id='bge-m3-dense-v1'),
 weights_sha256 text NOT NULL CHECK(weights_sha256='b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38'),
 embedding vector(1024) NOT NULL,PRIMARY KEY(owner_id,chunk_id),
 FOREIGN KEY(owner_id,chunk_id) REFERENCES knowledge_chunks(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE INDEX knowledge_semantic_hnsw ON knowledge_embeddings USING hnsw(embedding vector_cosine_ops) WITH(m=16,ef_construction=128);
CREATE TABLE knowledge_index_watermarks(
 owner_id uuid PRIMARY KEY REFERENCES users(id),model_id text NOT NULL,indexed_documents bigint NOT NULL DEFAULT 0,last_success_at timestamptz,
 last_indexed_revision bigint,updated_at timestamptz NOT NULL DEFAULT now()
);
-- Only explicit user/business sources appear here. Credentials, jobs, provider
-- payloads and generated charts are deliberately absent.
CREATE VIEW knowledge_sources AS
SELECT owner_id,'call'::text AS kind,id,submitted_at AS occurred_at,jsonb_build_object('identity','original_call','body',body,'submitted_at',submitted_at) AS body FROM calls
UNION ALL SELECT owner_id,'review',id,created_at,jsonb_build_object('identity','later_review','body',body) FROM reviews
UNION ALL SELECT owner_id,'outcome',id,created_at,jsonb_build_object('identity','system_outcome','call_id',call_id,'claim_no',claim_no,'kind',kind,'result',result,'supersedes',supersedes) FROM outcomes
UNION ALL SELECT owner_id,'tag',id,created_at,jsonb_build_object('name',name,'definition',definition,'aliases',aliases,'version',version) FROM tags
UNION ALL SELECT owner_id,'playbook',id,created_at,body FROM playbooks
UNION ALL SELECT e.owner_id,'playbook_event',e.id,e.created_at,jsonb_build_object('playbook_id',e.playbook_id,'status',e.status,'transition',d.body) FROM playbook_events e LEFT JOIN playbook_transition_details d ON d.owner_id=e.owner_id AND d.event_id=e.id
UNION ALL SELECT owner_id,'episode',id,anchor_at,jsonb_build_object('instrument',instrument,'market',market,'anchor_at',anchor_at,'end_at',end_at) FROM episodes
UNION ALL SELECT owner_id,'episode_link',id,created_at,to_jsonb(l)-'owner_id' FROM episode_links l
UNION ALL SELECT owner_id,'episode_review',id,created_at,jsonb_build_object('episode_id',episode_id,'review',body->'review','evidence_sha256',evidence_sha256) FROM episode_reviews
UNION ALL SELECT owner_id,'execution_link',id,created_at,body||jsonb_build_object('identity','retrospective_execution_link') FROM execution_links
UNION ALL SELECT e.owner_id,'execution_summary',e.id,e.created_at,jsonb_build_object('identity','actual_execution_summary','connection_id',e.id,'venue',e.venue,'market',e.market,'name',e.name,'ledger_revision',e.ledger_revision,
 'fills',(SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]') FROM(SELECT settlement_asset AS asset,count(*) AS fills,sum(realized_pnl)::text AS known_realized_pnl,count(*) FILTER(WHERE realized_pnl IS NULL) AS missing_realized_pnl FROM trade_fills f WHERE f.owner_id=e.owner_id AND f.connection_id=e.id GROUP BY settlement_asset)t),
 'fees',(SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]') FROM(SELECT commission_asset AS asset,sum(commission)::text AS commission FROM trade_fills f WHERE f.owner_id=e.owner_id AND f.connection_id=e.id GROUP BY commission_asset)t),
 'ledger',(SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]') FROM(SELECT kind,asset,sum(amount)::text AS amount FROM account_ledger_entries a WHERE a.owner_id=e.owner_id AND a.connection_id=e.id GROUP BY kind,asset)t)) FROM exchange_connections e
UNION ALL SELECT owner_id,'statistics',id,source_snapshot_at,jsonb_build_object('definition_id',definition_id,'stats',stats) FROM set_runs WHERE status='ready'
UNION ALL SELECT owner_id,'verdict',id,created_at,body||jsonb_build_object('decision',decision,'identity','explicit_user_verdict') FROM verdict_events
UNION ALL SELECT owner_id,'baseline',id,created_at,result FROM baseline_runs WHERE status='ready';
CREATE FUNCTION mark_knowledge_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('INSERT INTO knowledge_dirty(owner_id,source_kind,source_id) SELECT DISTINCT owner_id,%L,%I FROM changed WHERE %I IS NOT NULL ON CONFLICT(owner_id,source_kind,source_id) DO UPDATE SET revision=nextval(''knowledge_mutation''),changed_at=now()',TG_ARGV[0],TG_ARGV[1],TG_ARGV[1]);
 IF TG_OP='DELETE' AND TG_ARGV[2]='source' THEN
  EXECUTE format('DELETE FROM knowledge_documents d USING changed c WHERE d.owner_id=c.owner_id AND d.source_kind=%L AND d.source_id=c.%I',TG_ARGV[0],TG_ARGV[1]);
 END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('calls','call','id','source'),('reviews','review','id','source'),('outcomes','outcome','id','source'),('tags','tag','id','source'),('playbooks','playbook','id','source'),('playbook_events','playbook_event','id','source'),('playbook_transition_details','playbook_event','event_id','dependency'),('episodes','episode','id','source'),('episode_links','episode_link','id','source'),('episode_reviews','episode_review','id','source'),('execution_links','execution_link','id','source'),('exchange_connections','execution_summary','id','source'),('trade_fills','execution_summary','connection_id','dependency'),('account_ledger_entries','execution_summary','connection_id','dependency'),('set_runs','statistics','id','source'),('verdict_events','verdict','id','source'),('baseline_runs','baseline','id','source')) x(tab,kind,idcol,role) LOOP
 EXECUTE format('CREATE TRIGGER knowledge_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION mark_knowledge_dirty(%L,%L,%L)',r.tab,r.kind,r.idcol,r.role);
 EXECUTE format('CREATE TRIGGER knowledge_update AFTER UPDATE ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION mark_knowledge_dirty(%L,%L,%L)',r.tab,r.kind,r.idcol,r.role);
 EXECUTE format('CREATE TRIGGER knowledge_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION mark_knowledge_dirty(%L,%L,%L)',r.tab,r.kind,r.idcol,r.role);
 END LOOP;
END $$;
INSERT INTO knowledge_dirty(owner_id,source_kind,source_id) SELECT owner_id,kind,id FROM knowledge_sources ON CONFLICT DO NOTHING;
