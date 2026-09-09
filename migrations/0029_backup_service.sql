-- Operational repository and Keychain references never enter logical user archives.
CREATE TABLE backup_configurations(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),body jsonb NOT NULL,repository_id text,enabled boolean NOT NULL,
 initialized_at timestamptz,last_success_at timestamptz,last_snapshot_id text,next_run_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id)
);
CREATE UNIQUE INDEX one_enabled_backup_per_owner ON backup_configurations(owner_id) WHERE enabled;
CREATE TABLE backup_runs(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,configuration_id uuid NOT NULL,export_id uuid NOT NULL,status text NOT NULL DEFAULT 'queued',
 snapshot_id text,source_snapshot_at timestamptz,completed_at timestamptz,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id),
 FOREIGN KEY(id) REFERENCES jobs(id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,configuration_id) REFERENCES backup_configurations(owner_id,id) DEFERRABLE
);
CREATE TABLE backup_protections(
 owner_id uuid NOT NULL,run_id uuid NOT NULL,export_id uuid NOT NULL,lease_until timestamptz NOT NULL,
 PRIMARY KEY(owner_id,run_id),FOREIGN KEY(owner_id,run_id) REFERENCES backup_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
