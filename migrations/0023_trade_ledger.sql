CREATE TABLE exchange_connections(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),venue text NOT NULL CHECK(venue='binance'),
 market text NOT NULL CHECK(market IN ('usd_m','coin_m')),name text NOT NULL,account_label text NOT NULL,
 ledger_revision bigint NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),disabled_at timestamptz,
 UNIQUE(owner_id,id),UNIQUE(owner_id,venue,market,account_label)
);
-- Credential references are operational and excluded from logical exports.
CREATE TABLE exchange_credentials(owner_id uuid NOT NULL,connection_id uuid NOT NULL,keychain_service text NOT NULL,PRIMARY KEY(owner_id,connection_id),FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE);
CREATE TABLE trade_imports(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,connection_id uuid NOT NULL,source text NOT NULL,provenance text NOT NULL,
 source_hash text NOT NULL,dataset text NOT NULL CHECK(dataset IN ('trades','ledger','both')),start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,symbols text[] NOT NULL,
 declared_complete boolean NOT NULL,status text NOT NULL,inserted_fills bigint NOT NULL DEFAULT 0,inserted_entries bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE,CHECK(start_at<end_at)
);
CREATE TABLE trade_fills(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,connection_id uuid NOT NULL,import_id uuid NOT NULL,
 symbol text NOT NULL,trade_id text NOT NULL,trade_sequence numeric(38,0) NOT NULL,order_id text,
 position_side text NOT NULL CHECK(position_side IN ('BOTH','LONG','SHORT')),side text NOT NULL CHECK(side IN ('BUY','SELL')),
 traded_at timestamptz NOT NULL,price numeric NOT NULL CHECK(price>0),quantity numeric NOT NULL CHECK(quantity>0),
 realized_pnl numeric,settlement_asset text NOT NULL,commission numeric NOT NULL,commission_asset text NOT NULL,body jsonb NOT NULL,
 ingested_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id),UNIQUE(owner_id,connection_id,symbol,trade_id),
 FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,import_id) REFERENCES trade_imports(owner_id,id)
);
CREATE INDEX trade_fill_replay ON trade_fills(owner_id,connection_id,symbol,position_side,traded_at,trade_sequence);
CREATE INDEX trade_fill_page ON trade_fills(owner_id,traded_at,id);
CREATE TABLE account_ledger_entries(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,connection_id uuid NOT NULL,import_id uuid NOT NULL,transaction_id text NOT NULL,
 kind text NOT NULL,symbol text,asset text NOT NULL,amount numeric NOT NULL,occurred_at timestamptz NOT NULL,trade_id text,body jsonb NOT NULL,
 UNIQUE(owner_id,id),UNIQUE(owner_id,connection_id,kind,transaction_id),
 FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,import_id) REFERENCES trade_imports(owner_id,id)
);
CREATE INDEX account_ledger_range ON account_ledger_entries(owner_id,connection_id,occurred_at,kind);
CREATE TABLE position_seeds(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,connection_id uuid NOT NULL,symbol text NOT NULL,position_side text NOT NULL,
 effective_at timestamptz NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE trade_projection_runs(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,connection_id uuid NOT NULL,ledger_revision bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('building','ready','superseded')),created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 UNIQUE(owner_id,id),FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE trade_cycles(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,run_id uuid NOT NULL,connection_id uuid NOT NULL,symbol text NOT NULL,position_side text NOT NULL,
 ordinal bigint NOT NULL,body jsonb NOT NULL,UNIQUE(owner_id,id),UNIQUE(run_id,symbol,position_side,ordinal),
 FOREIGN KEY(owner_id,run_id) REFERENCES trade_projection_runs(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE trade_cycle_allocations(
 owner_id uuid NOT NULL,cycle_id uuid NOT NULL,fill_id uuid NOT NULL,quantity numeric NOT NULL,commission numeric NOT NULL,portion text NOT NULL,
 PRIMARY KEY(owner_id,cycle_id,fill_id),FOREIGN KEY(owner_id,cycle_id) REFERENCES trade_cycles(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,fill_id) REFERENCES trade_fills(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE trade_projection_heads(
 owner_id uuid NOT NULL,connection_id uuid NOT NULL,run_id uuid NOT NULL,PRIMARY KEY(owner_id,connection_id),
 FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,run_id) REFERENCES trade_projection_runs(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE trade_reconciliations(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,connection_id uuid NOT NULL,ledger_revision bigint NOT NULL,body jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id),FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE execution_links(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,connection_id uuid NOT NULL,call_id uuid,episode_id uuid,playbook_id uuid,
 relation text NOT NULL,body jsonb NOT NULL,supersedes uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,episode_id) REFERENCES episodes(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,playbook_id) REFERENCES playbooks(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,supersedes) REFERENCES execution_links(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE execution_link_fills(owner_id uuid NOT NULL,link_id uuid NOT NULL,fill_id uuid NOT NULL,PRIMARY KEY(owner_id,link_id,fill_id),FOREIGN KEY(owner_id,link_id) REFERENCES execution_links(owner_id,id) ON DELETE CASCADE,FOREIGN KEY(owner_id,fill_id) REFERENCES trade_fills(owner_id,id) ON DELETE CASCADE);
CREATE TABLE exchange_sync_runs(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,connection_id uuid NOT NULL,body jsonb NOT NULL,symbol_no int NOT NULL DEFAULT 0,
 next_start timestamptz NOT NULL,last_page_hash text,next_trade_id text,next_income_page int NOT NULL DEFAULT 1,phase text NOT NULL DEFAULT 'trades',status text NOT NULL DEFAULT 'running',
 created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(id) REFERENCES jobs(id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,connection_id) REFERENCES exchange_connections(owner_id,id) ON DELETE CASCADE
);

DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT conrelid::regclass AS tab,conname FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace AND NOT condeferrable LOOP
  EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',r.tab,r.conname);
 END LOOP;
END $$;
