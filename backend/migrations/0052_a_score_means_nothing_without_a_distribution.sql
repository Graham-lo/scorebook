-- §5.5-3：0.62 分到底算像还是不像，只看分数是答不出来的——同一个分数在 1d/256
-- 那一档可能是万里挑一，在 4h/64 那一档可能随手一截就有。所以先把「随便截一段去
-- 找，最像的那条能到多少分」这件事量出来：每个 (周期, 窗口档位) 抽若干个索引窗口
-- 当查询，跑同样的 ANN+精排（排除自身附近），把 top-1 的分记在这里。查询时一条
-- 结果的稀有度就是「这一档样本里有多少比例低于它」，词（很像/像/有点像）由稀有度
-- 决定，不由绝对分决定。
--
-- 一行一个样本、不预先聚合成分位数：分位数的口径以后会改（0.97/0.85/0.6 是这一
-- 版的选择），样本本身不会。存样本，口径随时能重算；只存分位数，改口径就得重跑。
CREATE TABLE chart_match_calibration(
  id bigserial PRIMARY KEY,
  interval text NOT NULL,
  bars_bucket int NOT NULL,
  sample_score numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chart_match_calibration_bucket ON chart_match_calibration(interval,bars_bucket,sample_score);
