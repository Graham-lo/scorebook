CREATE TABLE export_artifacts(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),state text NOT NULL DEFAULT 'writing' CHECK(state IN ('writing','copying','ready','failed','expired')),lease_until timestamptz NOT NULL DEFAULT now()+interval '5 minutes',manifest_sha256 text,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',UNIQUE(owner_id,id));
CREATE INDEX export_artifacts_expiry ON export_artifacts(expires_at,id);
-- Export artifacts can also be created by offline backup tooling, independently of a queue job.
ALTER TABLE export_refs DROP CONSTRAINT export_refs_export_id_fkey;
CREATE TABLE export_pins(owner_id uuid NOT NULL,export_id uuid NOT NULL,attachment_id uuid NOT NULL,sha256 text NOT NULL,PRIMARY KEY(owner_id,export_id,attachment_id),FOREIGN KEY(owner_id,export_id) REFERENCES export_artifacts(owner_id,id) ON DELETE CASCADE);
-- One-time explicit repair of digests invalidated by the old raw-data removal migration.
CREATE FUNCTION compact_jsonb(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE jsonb_typeof(v)
 WHEN 'object' THEN '{'||COALESCE((SELECT string_agg(to_jsonb(key)::text||':'||compact_jsonb(value),',' ORDER BY key COLLATE "C") FROM jsonb_each(v)),'')||'}'
 WHEN 'array' THEN '['||COALESCE((SELECT string_agg(compact_jsonb(value),',' ORDER BY ordinal) FROM jsonb_array_elements(v) WITH ORDINALITY AS a(value,ordinal)),'')||']'
 ELSE v::text END
$$;
CREATE TABLE manifest_migrations(owner_id uuid NOT NULL,manifest_id uuid NOT NULL,old_digest text NOT NULL,new_digest text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,manifest_id),FOREIGN KEY(owner_id,manifest_id) REFERENCES manifests(owner_id,id) ON DELETE CASCADE);
ALTER TABLE manifests DISABLE TRIGGER immutable_update;
WITH changed AS (
 SELECT id,owner_id,digest AS old_digest,body||jsonb_build_object('market_input_sha256','unavailable:redacted_before_v3','replay_verification','unverifiable_redacted_evidence','prior_manifest_digest',digest) AS new_body
 FROM manifests WHERE body->>'market_input_storage'='not_persisted' AND body->>'market_input_sha256' IS NULL
), updated AS (
 UPDATE manifests m SET body=c.new_body,digest=encode(sha256(convert_to(compact_jsonb(c.new_body),'UTF8')),'hex') FROM changed c WHERE m.id=c.id RETURNING m.id,m.owner_id,m.digest,c.old_digest
) INSERT INTO manifest_migrations(owner_id,manifest_id,old_digest,new_digest,reason) SELECT owner_id,id,old_digest,digest,'explicit_v3_digest_after_prior_raw_redaction' FROM updated;
ALTER TABLE manifests ENABLE TRIGGER immutable_update;
DROP FUNCTION compact_jsonb(jsonb);
DELETE FROM jobs WHERE kind='market';
ALTER TABLE export_artifacts ADD COLUMN lease_token uuid NOT NULL;
ALTER TABLE playbooks DROP CONSTRAINT playbooks_owner_id_parent_id_fkey;
ALTER TABLE playbooks ADD CONSTRAINT playbooks_owner_id_parent_id_fkey FOREIGN KEY(owner_id,parent_id) REFERENCES playbooks(owner_id,id) DEFERRABLE INITIALLY DEFERRED;
