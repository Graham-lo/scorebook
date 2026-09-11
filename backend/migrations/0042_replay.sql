CREATE TABLE attachment_locations(
  owner_id uuid NOT NULL, attachment_id uuid NOT NULL,
  symbol text NOT NULL, market text NOT NULL CHECK(market IN ('usd_m','coin_m')),
  interval text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  bars_count int, source text NOT NULL CHECK(source IN ('rest','monthly_archive')),
  score numeric, search_run_id uuid, confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,attachment_id),
  FOREIGN KEY(owner_id,attachment_id) REFERENCES attachments(owner_id,id) ON DELETE CASCADE,
  CHECK(start_at<end_at)
);
CREATE TABLE chart_setups(
  owner_id uuid NOT NULL, call_id uuid NOT NULL, body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,call_id),
  FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE replay_bars(
  market text NOT NULL, symbol text NOT NULL, interval text NOT NULL,
  bar_start timestamptz NOT NULL, bar_end timestamptz NOT NULL,
  open text NOT NULL, high text NOT NULL, low text NOT NULL, close text NOT NULL,
  source text NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY(market,symbol,interval,bar_start)
);
CREATE INDEX replay_bars_expiry ON replay_bars(expires_at);
