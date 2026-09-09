CREATE TABLE storage_objects(owner_id uuid NOT NULL REFERENCES users(id),id uuid NOT NULL,state text NOT NULL CHECK(state IN ('pending','ready','expired','purged')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,id));
INSERT INTO storage_objects(owner_id,id,state,created_at) SELECT owner_id,id,'ready',uploaded_at FROM attachments;
CREATE INDEX storage_objects_pending ON storage_objects(created_at,owner_id,id) WHERE state='pending';
CREATE INDEX jobs_owner_queue_state ON jobs(owner_id,queue,status,created_at);
CREATE INDEX attempts_finished ON job_attempts(finished_at,job_id,attempt) WHERE finished_at IS NOT NULL;
CREATE INDEX transient_request_expiry ON requests(created_at,owner_id,operation,key) WHERE operation IN ('similarity.search','similarity.hybrid','history.search','review_draft.save') AND NOT response ? 'expired' AND NOT response ? 'deleted';
