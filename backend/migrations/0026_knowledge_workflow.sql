CREATE TABLE tag_revisions(
 owner_id uuid NOT NULL,tag_id uuid NOT NULL,root_id uuid NOT NULL,parent_id uuid,reason text NOT NULL,
 PRIMARY KEY(owner_id,tag_id),UNIQUE(owner_id,parent_id),
 FOREIGN KEY(owner_id,tag_id) REFERENCES tags(owner_id,id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,root_id) REFERENCES tags(owner_id,id) DEFERRABLE,
 FOREIGN KEY(owner_id,parent_id) REFERENCES tags(owner_id,id) DEFERRABLE
);
WITH ordered AS(SELECT owner_id,id,first_value(id) OVER(PARTITION BY owner_id,name ORDER BY version) AS root,lag(id) OVER(PARTITION BY owner_id,name ORDER BY version) AS parent FROM tags)
INSERT INTO tag_revisions SELECT owner_id,id,root,parent,'v4_explicit_lineage_migration' FROM ordered;
CREATE TABLE playbook_transition_details(
 owner_id uuid NOT NULL,event_id uuid NOT NULL,previous_event_id uuid NOT NULL,body jsonb NOT NULL,
 PRIMARY KEY(owner_id,event_id),UNIQUE(owner_id,previous_event_id),
 FOREIGN KEY(event_id) REFERENCES playbook_events(id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(previous_event_id) REFERENCES playbook_events(id) DEFERRABLE
);
CREATE TABLE episode_reviews(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,episode_id uuid NOT NULL,body jsonb NOT NULL,evidence_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,episode_id) REFERENCES episodes(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE episode_review_refs(
 owner_id uuid NOT NULL,review_id uuid NOT NULL,call_id uuid NOT NULL,
 PRIMARY KEY(owner_id,review_id,call_id),FOREIGN KEY(owner_id,review_id) REFERENCES episode_reviews(owner_id,id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE submission_feedback(
 owner_id uuid NOT NULL,call_id uuid NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,call_id),FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE INDEX latest_playbook_event ON playbook_events(owner_id,playbook_id,created_at DESC,id DESC);
CREATE INDEX latest_episode_links ON episode_links(owner_id,call_id,created_at DESC,id DESC);
CREATE TRIGGER protect_episode_reviews BEFORE UPDATE ON episode_reviews FOR EACH ROW EXECUTE FUNCTION reject_evidence_update();
CREATE TRIGGER protect_feedback BEFORE UPDATE ON submission_feedback FOR EACH ROW EXECUTE FUNCTION reject_evidence_update();
CREATE TRIGGER protect_trade_fills BEFORE UPDATE ON trade_fills FOR EACH ROW EXECUTE FUNCTION reject_evidence_update();
CREATE TRIGGER protect_account_ledger BEFORE UPDATE ON account_ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_evidence_update();
CREATE TRIGGER protect_execution_links BEFORE UPDATE ON execution_links FOR EACH ROW EXECUTE FUNCTION reject_evidence_update();
