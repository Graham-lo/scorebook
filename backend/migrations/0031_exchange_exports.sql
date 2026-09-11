CREATE TABLE exchange_export_runs(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,connection_id uuid NOT NULL,body jsonb NOT NULL,status text NOT NULL DEFAULT 'prepared',
 download_id text,source_hash text,imported_rows bigint NOT NULL DEFAULT 0,header jsonb,completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id),
 FOREIGN KEY(id) REFERENCES jobs(id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
-- Reservations include uncertain submissions. No blind retry can burn another
-- monthly export. Website usage is an explicit external reservation as well.
CREATE TABLE exchange_export_reservations(
 owner_id uuid NOT NULL,connection_id uuid NOT NULL,dataset text NOT NULL,month date NOT NULL,
 run_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,run_id),FOREIGN KEY(owner_id,run_id) REFERENCES exchange_export_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
CREATE INDEX exchange_export_quota ON exchange_export_reservations(owner_id,connection_id,dataset,month);
CREATE TABLE exchange_export_resolutions(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,run_id uuid NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,run_id) REFERENCES exchange_export_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
