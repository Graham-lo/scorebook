ALTER TABLE exchange_connections ADD COLUMN configuration_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE trade_fills ADD COLUMN ingested_revision bigint NOT NULL DEFAULT 0;
CREATE INDEX trade_fill_increment ON trade_fills(owner_id,connection_id,symbol,position_side,ingested_revision,traded_at,trade_sequence);
CREATE TABLE trade_projection_segments(
 owner_id uuid NOT NULL,run_id uuid NOT NULL,symbol text NOT NULL,position_side text NOT NULL,
 source_run_id uuid NOT NULL,first_ordinal bigint NOT NULL,last_ordinal bigint NOT NULL,
 PRIMARY KEY(owner_id,run_id,symbol,position_side,source_run_id,first_ordinal),CHECK(first_ordinal<=last_ordinal),
 FOREIGN KEY(owner_id,run_id) REFERENCES trade_projection_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,source_run_id) REFERENCES trade_projection_runs(owner_id,id) DEFERRABLE
);
CREATE TABLE trade_projection_checkpoints(
 owner_id uuid NOT NULL,run_id uuid NOT NULL,symbol text NOT NULL,position_side text NOT NULL,
 seed_hash text NOT NULL,last_at timestamptz NOT NULL,last_sequence numeric(38,0) NOT NULL,body jsonb NOT NULL,
 PRIMARY KEY(owner_id,run_id,symbol,position_side),
 FOREIGN KEY(owner_id,run_id) REFERENCES trade_projection_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
-- Explicit one-time cutover. Existing snapshots remain readable; active projections
-- are rebuilt under one checkpoint protocol, never decoded with an older algorithm.
INSERT INTO trade_projection_segments SELECT owner_id,run_id,symbol,position_side,run_id,min(ordinal),max(ordinal) FROM trade_cycles GROUP BY owner_id,run_id,symbol,position_side;
INSERT INTO jobs(id,owner_id,kind,dedupe_key,body,queue)
SELECT gen_random_uuid(),owner_id,'trade.project','incremental-v1:'||id||':'||ledger_revision,jsonb_build_object('connection_id',id,'ledger_revision',ledger_revision),'batch' FROM exchange_connections WHERE EXISTS(SELECT 1 FROM trade_projection_heads h WHERE h.connection_id=exchange_connections.id);
DELETE FROM trade_projection_heads;
ALTER TABLE trade_cycles ADD COLUMN allocation_parent_id uuid;
ALTER TABLE trade_cycles ADD FOREIGN KEY(owner_id,allocation_parent_id) REFERENCES trade_cycles(owner_id,id) DEFERRABLE;
CREATE TABLE trade_books(
 owner_id uuid NOT NULL,connection_id uuid NOT NULL,symbol text NOT NULL,position_side text NOT NULL,settlement_asset text NOT NULL,
 PRIMARY KEY(owner_id,connection_id,symbol,position_side,settlement_asset),
 FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
INSERT INTO trade_books SELECT DISTINCT owner_id,connection_id,symbol,position_side,settlement_asset FROM trade_fills;
CREATE INDEX trade_fill_import ON trade_fills(owner_id,import_id);
