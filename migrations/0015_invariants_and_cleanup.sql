CREATE TABLE export_runs(owner_id uuid NOT NULL,export_id uuid NOT NULL,token uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,export_id,token),FOREIGN KEY(owner_id,export_id) REFERENCES export_artifacts(owner_id,id) ON DELETE CASCADE);
CREATE INDEX export_runs_age ON export_runs(created_at,owner_id);
CREATE INDEX private_corpus_version ON image_embeddings(owner_id,model_id,created_at DESC);
CREATE INDEX public_generation_recency ON public_market.generations(published_at DESC,id DESC) WHERE status='ready';
CREATE INDEX public_generation_scope ON public_market.generations((body->>'market'),(body->>'symbol'),(body->>'interval'),published_at DESC,id DESC) WHERE status='ready';
ALTER TABLE outcomes ADD CONSTRAINT revision_requires_predecessor CHECK((kind='data_revision')=(supersedes IS NOT NULL));
CREATE FUNCTION verify_outcome_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM outcomes WHERE owner_id=NEW.owner_id AND call_id=NEW.call_id AND claim_no=NEW.claim_no AND id=NEW.outcome_id AND kind IN ('original','data_revision')) THEN RAISE EXCEPTION 'official head requires an original or data revision'; END IF; RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER official_head AFTER INSERT OR UPDATE ON outcome_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_outcome_head();
CREATE FUNCTION verify_revision_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.supersedes IS NOT NULL AND NOT EXISTS(SELECT 1 FROM outcomes WHERE owner_id=NEW.owner_id AND call_id=NEW.call_id AND claim_no=NEW.claim_no AND id=NEW.supersedes AND kind IN ('original','data_revision') AND created_at<NEW.created_at) THEN RAISE EXCEPTION 'data revision requires an earlier official outcome'; END IF; RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ordered_data_revision AFTER INSERT ON outcomes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_revision_order();

CREATE TABLE gc_schedule(owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,last_scheduled_at timestamptz NOT NULL DEFAULT '1970-01-01');
INSERT INTO gc_schedule(owner_id) SELECT id FROM users;
CREATE INDEX gc_schedule_turn ON gc_schedule(last_scheduled_at,owner_id);
CREATE FUNCTION register_gc_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO gc_schedule(owner_id) VALUES(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER register_gc_owner AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION register_gc_owner();
CREATE INDEX reviews_history_page ON reviews(owner_id,call_id,created_at DESC,id DESC);
CREATE INDEX outcomes_history_page ON outcomes(owner_id,call_id,created_at DESC,id DESC);
