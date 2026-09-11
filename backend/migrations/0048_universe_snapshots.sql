-- 刻舟求剑的检索面：把「这一轮到底搜了哪些品种」和扇出作业的进度都记下来。
--
-- 24 小时 ticker 是一张快照，前 200 名每天都在变。如果只把名单当成临时变量传给
-- 作业，事后没有任何人答得出「这次到底搜了哪 200 个、截止到哪一天」——一页说不清
-- 自己比过什么，结果就不该给人看。所以名单落库存档：快照时间、market、以及每个
-- 品种当时的名次、成交额、成交笔数，三样都存原值，不只存排名。
CREATE TABLE public_market.universe_snapshots(
  id uuid PRIMARY KEY,
  captured_at timestamptz NOT NULL DEFAULT now(),
  market text NOT NULL CHECK(market IN ('usd_m','coin_m')),
  -- 名单实际有多少个（候选不足 200 时就是实际数目，不补齐）。
  size int NOT NULL CHECK(size > 0),
  -- 候选池总量：这 size 个是从多少个合约里挑出来的。
  candidates int NOT NULL CHECK(candidates >= size),
  ranking text NOT NULL,
  source text NOT NULL
);
CREATE TABLE public_market.universe_members(
  snapshot_id uuid NOT NULL REFERENCES public_market.universe_snapshots(id) ON DELETE CASCADE,
  -- 合成名次：成交额名次 + 笔数名次（Borda）升序后的位置，从 1 开始。
  rank int NOT NULL CHECK(rank > 0),
  symbol text NOT NULL,
  -- 24h 成交额。usd_m 直接是 quoteVolume；coin_m 是张数 × 合约面值。
  quote_volume numeric NOT NULL,
  -- 24h 成交笔数，ticker 里的 count。
  trade_count bigint NOT NULL,
  turnover_rank int NOT NULL,
  trades_rank int NOT NULL,
  PRIMARY KEY(snapshot_id,symbol),
  UNIQUE(snapshot_id,rank)
);

-- 扇出作业的进度。这是个几小时的作业，不是点一下等一会儿：走到第几个品种、这个
-- 品种第几段、写了多少特征行、跳过多少已覆盖的单元、失败了哪些，都要能当场查出来。
-- 作业本身按 (品种, 周期, 一段月份) 分单元推进，单元做完就有永久标记
--（generations.status='ready' + coverage_segments.status='complete' + features.published），
-- 所以这张表只是「看得见」，不是续跑的真相源：删了它作业也能凭永久标记续上。
CREATE TABLE public_market.universe_index_runs(
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  snapshot_id uuid REFERENCES public_market.universe_snapshots(id),
  market text NOT NULL CHECK(market IN ('usd_m','coin_m')),
  timeframe text NOT NULL,
  status text NOT NULL CHECK(status IN ('running','completed')),
  symbols_total int NOT NULL DEFAULT 0,
  -- 下一个要处理的品种序号，也是「已经走完几个」。续跑从这里接着走。
  symbol_no int NOT NULL DEFAULT 0,
  current_symbol text,
  current_range text,
  units_built bigint NOT NULL DEFAULT 0,
  units_skipped bigint NOT NULL DEFAULT 0,
  units_failed bigint NOT NULL DEFAULT 0,
  months_downloaded bigint NOT NULL DEFAULT 0,
  feature_rows bigint NOT NULL DEFAULT 0,
  -- 最近若干条失败记录（品种 / 月份 / 错误码）。缺月份是常态不是错误，留证据即可。
  failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX universe_index_run_scope ON public_market.universe_index_runs(market,timeframe,started_at DESC);
REVOKE ALL ON ALL TABLES IN SCHEMA public_market FROM PUBLIC;
