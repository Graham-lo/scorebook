-- Processing state is not a business verdict. New workers only use this state machine.
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK(status IN ('queued','running','succeeded','failed','retry_wait','blocked_capability','awaiting_input','needs_attention','cancelled'));
ALTER TABLE jobs ADD COLUMN cycle_attempt int NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN generation bigint NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN queue text NOT NULL DEFAULT 'interactive' CHECK(queue IN ('interactive','batch','maintenance'));
UPDATE jobs SET queue=CASE WHEN kind='history.index' THEN 'batch' WHEN kind IN ('export','purge_files') THEN 'maintenance' ELSE 'interactive' END;
CREATE TABLE job_attempts(
  owner_id uuid NOT NULL REFERENCES users(id), job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt int NOT NULL,generation bigint NOT NULL,lease_owner uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,status text NOT NULL DEFAULT 'running',error_code text,retry jsonb,
  PRIMARY KEY(job_id,attempt)
);
CREATE INDEX jobs_due_v3 ON jobs(queue,run_after,created_at,id) WHERE status IN ('queued','retry_wait');
CREATE INDEX jobs_expired_v3 ON jobs(queue,lease_until,id) WHERE status='running';
DROP INDEX jobs_ready;
CREATE TABLE assessments(
  owner_id uuid NOT NULL,call_id uuid NOT NULL,claim_no int NOT NULL,job_id uuid,
  state text NOT NULL,reason text,due_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,call_id,claim_no),FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE
);
ALTER TABLE outcomes ADD CONSTRAINT outcomes_identity UNIQUE(owner_id,call_id,claim_no,id);
ALTER TABLE outcomes ADD CONSTRAINT outcome_supersedes FOREIGN KEY(owner_id,call_id,claim_no,supersedes) REFERENCES outcomes(owner_id,call_id,claim_no,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE outcome_heads(
  owner_id uuid NOT NULL,call_id uuid NOT NULL,claim_no int NOT NULL,outcome_id uuid NOT NULL,revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(owner_id,call_id,claim_no),FOREIGN KEY(owner_id,call_id,claim_no,outcome_id) REFERENCES outcomes(owner_id,call_id,claim_no,id) ON DELETE CASCADE
);
INSERT INTO outcome_heads(owner_id,call_id,claim_no,outcome_id)
SELECT DISTINCT ON(owner_id,call_id,claim_no) owner_id,call_id,claim_no,id FROM outcomes WHERE kind IN ('original','data_revision') ORDER BY owner_id,call_id,claim_no,created_at DESC,id DESC;
CREATE UNIQUE INDEX one_outcome_successor ON outcomes(owner_id,supersedes) WHERE supersedes IS NOT NULL;
INSERT INTO assessments(owner_id,call_id,claim_no,job_id,state,due_at)
SELECT owner_id,(body->>'call_id')::uuid,(body->>'claim_no')::int,id,
CASE WHEN status='succeeded' THEN 'completed' WHEN status='failed' THEN 'needs_attention' ELSE 'queued' END,run_after
FROM jobs WHERE kind='assess' AND EXISTS(SELECT 1 FROM calls c WHERE c.owner_id=jobs.owner_id AND c.id=(jobs.body->>'call_id')::uuid)
ON CONFLICT DO NOTHING;
-- Explicitly flag old inconclusive evaluations; no old result is overwritten or guessed.
UPDATE assessments a SET state='needs_attention',reason='legacy_inconclusive_requires_review'
FROM outcome_heads h JOIN outcomes o ON o.id=h.outcome_id
WHERE a.owner_id=h.owner_id AND a.call_id=h.call_id AND a.claim_no=h.claim_no AND o.result->>'state'='insufficient_data';
