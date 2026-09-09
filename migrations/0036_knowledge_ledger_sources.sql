CREATE INDEX account_ledger_import ON account_ledger_entries(owner_id,import_id);
CREATE TABLE account_asset_totals(
 owner_id uuid NOT NULL,connection_id uuid NOT NULL,kind text NOT NULL,asset text NOT NULL,
 amount numeric NOT NULL,entry_count bigint NOT NULL,missing_count bigint NOT NULL,
 PRIMARY KEY(owner_id,connection_id,kind,asset),FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
INSERT INTO account_asset_totals
SELECT owner_id,connection_id,'fill_realized_pnl',settlement_asset,COALESCE(sum(realized_pnl),0),count(*),count(*) FILTER(WHERE realized_pnl IS NULL) FROM trade_fills GROUP BY owner_id,connection_id,settlement_asset
UNION ALL SELECT owner_id,connection_id,'fill_commission',commission_asset,sum(commission),count(*),0 FROM trade_fills GROUP BY owner_id,connection_id,commission_asset
UNION ALL SELECT owner_id,connection_id,'income:'||kind,asset,sum(amount),count(*),0 FROM account_ledger_entries GROUP BY owner_id,connection_id,kind,asset;
CREATE OR REPLACE VIEW knowledge_sources AS
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
 'fills',(SELECT COALESCE(jsonb_agg(jsonb_build_object('asset',asset,'fills',entry_count,'known_realized_pnl',amount::text,'missing_realized_pnl',missing_count) ORDER BY asset),'[]') FROM account_asset_totals WHERE owner_id=e.owner_id AND connection_id=e.id AND kind='fill_realized_pnl'),
 'fees',(SELECT COALESCE(jsonb_agg(jsonb_build_object('asset',asset,'commission',amount::text) ORDER BY asset),'[]') FROM account_asset_totals WHERE owner_id=e.owner_id AND connection_id=e.id AND kind='fill_commission'),
 'ledger',(SELECT COALESCE(jsonb_agg(jsonb_build_object('asset',asset,'kind',substring(kind FROM 8),'amount',amount::text) ORDER BY kind,asset),'[]') FROM account_asset_totals WHERE owner_id=e.owner_id AND connection_id=e.id AND kind LIKE 'income:%')) FROM exchange_connections e
UNION ALL SELECT owner_id,'statistics',id,source_snapshot_at,jsonb_build_object('definition_id',definition_id,'stats',stats) FROM set_runs WHERE status='ready'
UNION ALL SELECT owner_id,'verdict',id,created_at,body||jsonb_build_object('decision',decision,'identity','explicit_user_verdict') FROM verdict_events
UNION ALL SELECT owner_id,'baseline',id,created_at,result FROM baseline_runs WHERE status='ready'
UNION ALL SELECT owner_id,'import_receipt',id,created_at,to_jsonb(i)-'owner_id' FROM trade_imports i
UNION ALL SELECT owner_id,'position_seed',id,created_at,body||jsonb_build_object('identity','declared_opening_position') FROM position_seeds
UNION ALL SELECT owner_id,'reconciliation',id,created_at,jsonb_build_object('statement',body,'result',result,'ledger_revision',ledger_revision) FROM trade_reconciliations
UNION ALL SELECT owner_id,'submission_feedback',call_id,created_at,body FROM submission_feedback
UNION ALL SELECT t.owner_id,'tag_lineage',t.tag_id,g.created_at,to_jsonb(t)-'owner_id' FROM tag_revisions t JOIN tags g ON g.owner_id=t.owner_id AND g.id=t.tag_id
UNION ALL SELECT owner_id,'attachment',id,uploaded_at,jsonb_build_object('identity','user_original_image','sha256',sha256,'kind',kind,'mime',mime,'width',width,'height',height,'captured_at',captured_at) FROM attachments;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM(VALUES('trade_imports','import_receipt','id'),('position_seeds','position_seed','id'),('trade_reconciliations','reconciliation','id'),('submission_feedback','submission_feedback','call_id'),('tag_revisions','tag_lineage','tag_id'),('attachments','attachment','id')) x(tab,kind,idcol) LOOP
 EXECUTE format('CREATE TRIGGER knowledge_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION mark_knowledge_dirty(%L,%L,''source'')',r.tab,r.kind,r.idcol);
 EXECUTE format('CREATE TRIGGER knowledge_update AFTER UPDATE ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION mark_knowledge_dirty(%L,%L,''source'')',r.tab,r.kind,r.idcol);
 EXECUTE format('CREATE TRIGGER knowledge_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION mark_knowledge_dirty(%L,%L,''source'')',r.tab,r.kind,r.idcol);
 EXECUTE format('CREATE TRIGGER chat_source_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION invalidate_chat_sources(%L,%L,''source'')',r.tab,r.kind,r.idcol);
 END LOOP;
END $$;
INSERT INTO knowledge_dirty(owner_id,source_kind,source_id) SELECT owner_id,kind,id FROM knowledge_sources WHERE kind IN ('execution_summary','import_receipt','position_seed','reconciliation','submission_feedback','tag_lineage','attachment') ON CONFLICT(owner_id,source_kind,source_id) DO UPDATE SET revision=nextval('knowledge_mutation'),changed_at=now();
