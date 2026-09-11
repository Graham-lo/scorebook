CREATE TABLE assessment_source_plans(
 owner_id uuid NOT NULL,job_id uuid NOT NULL,source_plan text NOT NULL CHECK(source_plan IN ('rest_continuous_v1','daily_archive_v1')),
 generation bigint NOT NULL,reason text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,job_id),FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE DEFERRABLE
);
CREATE TABLE assessment_source_decisions(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,job_id uuid NOT NULL,generation bigint NOT NULL,source_plan text NOT NULL,reason text NOT NULL,
 checkpoint_sha256 text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,job_id,generation),
 FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE DEFERRABLE
);
