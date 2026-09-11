CREATE TABLE set_group_metrics(
 owner_id uuid NOT NULL,run_id uuid NOT NULL,signature text NOT NULL,body jsonb NOT NULL,
 PRIMARY KEY(owner_id,run_id,signature),FOREIGN KEY(owner_id,run_id) REFERENCES set_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
-- Explicit representation migration of already frozen v4 groups; no dual reader.
INSERT INTO set_group_metrics SELECT owner_id,id,g->>'signature',g FROM set_runs CROSS JOIN LATERAL jsonb_array_elements(COALESCE(stats->'groups','[]')) g;
