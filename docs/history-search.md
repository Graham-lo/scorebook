# 按图查找历史走势

当前采用 chart-match-v2。截图搜索必须明确周期，缺失返回 `chart_interval_required`；支持币安合约 klines 的全部 15 个周期：1m/3m/5m/15m/30m/1h/2h/4h/6h/8h/12h/1d/3d/1w/1M（区分大小写，`1m` 是分钟、`1M` 是月）。普通截图中的周期无法可靠识别时，必须由用户选择。OCR 提示不代替确认；不得从走势形状或上一张截图猜周期。

## 搜索流程

上传用户截图及可选 ROI，调用 `/v1/chart-analyses` 读可见文字和蜡烛几何。`/v1/chart-search/runs` 创建有明确 interval 的 private 或 binance_history 检索；worker 再次校验周期，所有候选 SQL 使用同周期等值条件。

历史路径从直接 OHLC 提取 candle-geometry-v2 的 192 维向量；个人记录路径使用几何和 DINOv2 两路，不自动降级。几何会将片段规范到 64 个采样点，向量用于初筛，详细比较使用规范化开高低收位置和有限时间错位对齐。分数是结构排序，不是预测概率。

向量候选预算为 3,000，物化后最多检查前 1,000 条，为每个合约保留最多 3 个不紧邻的片段，并选最多 30 个做真实来源核验和精排。公共结果最后按分数排序，每个合约保留最佳片段，默认 3 个；前端提供 3/5/10。个人记录按原图和已确认记录组去重，未知周期记录不混入。

人看过候选并说「都不是」时，那几条的 id 下一轮以 `exclude` 传回来（公开历史里是 `public_market.features` 的窗口 id，个人记录里是附件 id，结果条目自己带的那个 id 就是要写回来的东西）。排除写在 ANN 取数那一条 SQL 里——候选 CTE 的 `id<>ALL(...)`，**在 `LIMIT 3000` 之前**生效，不是查完之后再在内存里滤：滤在后面得到的只是同一批答案的短版本，而人要的是补上三条没看过的。`exclude` 是累加的，先去重再看上限，最多 100 条（`MAX_EXCLUDE`），越界 422；空列表时 `<>ALL('{}')` 恒为真，请求体与 SQL 行为跟从前逐字节相同。重温那一侧的「都不是」是另一件事——它改的不是这一轮的候选而是搜索范围，见 docs/replay-spec.md §1.7。

匹配完成后使用候选的 chart_request 再取数据，绘图请求的 match_end_at 标明原匹配结束位置。后续 32/64/128 根仅用于展示，不能影响召回、评分、排序。仅画真实已收盘 K 线，未来不存在就明说。候选指定 REST 或官方归档来源，不能静默换源。

## 历史范围与资源

索引 `/v1/history/indexes` 单次最多 50,000 根来源 K 线和 1,000 个窗口，逐批计算、最多每 500 条特征批量写入。长范围用 `/v1/history/plans`，每段最多 512 个窗口起点，按合约生命周期或已核实归档边界裁剪，并记录实际缺口。

“从上线到最新收盘”入口仅读取目录元数据，确认日期后才可显式开始准备，不自动建立订阅。旧目录的 first_seen_at 不是上线时间。目录存在也不等于全部来源数据已经可用；已发布覆盖以 `/v1/history/coverage` 为准。

特征、元数据、索引在 PostgreSQL/pgvector 的磁盘表中；查询只读取所需页并缓存。少量候选 K 线分组取入 RAM，原始行情和系统图不写数据库/文件/离线缓存。向量数越大仍有索引 I/O、缓存和维护成本，不宣称 TB 级单机性能已经验收。

## 索引的广度：按月档扇出（`history.universe`）

刻舟求剑要的是「广」：任意品种、任意周期地找相似结构。库里只有四个品种时，那句「任意」是假的。`history.universe` 作业（`batch` 队列）按 24 小时 ticker 取一个 market 的前 200 个合约，把它们的历史灌进 `public_market.features`。一条作业只做一个周期，这是用户明确要求的分法：粗周期先跑完，检索就能在那一档上工作，细周期什么时候跑由人决定。

名单排序是「24 小时成交额名次 + 24 小时成交笔数名次」两项相加（Borda）后升序，和相同按简称字典序（`application/instrument_popularity.rs`）。只按成交额排，几笔巨鲸单就足以把一个其实没人在交易的合约顶进名单；只按笔数排又会挑出一堆碎单的小票。名单连同每个品种当时的成交额、笔数和两项各自的名次一起存进 `public_market.universe_snapshots` / `universe_members`，作业进度存 `universe_index_runs`：ticker 是快照，前 200 名每天都在变，不存档事后就没人答得出「这一轮到底搜了哪 200 个、截止到哪一天」。

取数只走 `data.binance.vision` 的月度归档，不走 REST。`adapters/binance_archive.rs` 全文没有一处 `budget.reserve`，S3 静态对象不占 fapi 的限频配额——两百个品种、十年历史这件事能做，前提就是这一条。一段范围的月档并发下载一次，解析出来的 bars 直接喂给 64/128/256 三档窗口（`STRIDE=4`）各建一个世代，而不是每档各下一遍同一个 zip。作业每 45 秒（`STEP_BUDGET`）把进度写下来、让出队列。归档里缺一个月是常态（新币、下架、币安漏传），记进 `failures` 继续走。一根 K 线都不落盘，写下的仍然只有向量和时间坐标。

这条路目前**没有 HTTP 路由，openapi 里也没有条目**：作业靠直接往 `jobs` 插一行来排（kind `history.universe`，体里给 `market`/`interval`/`top`），入口是故意押后的。

## 当前运行决定与验收

按用户 2026-09-10 最新要求，只交付功能，不启动历史同步。实际测试用 BTC/ETH 两品种、1h/4h 两周期、每范围 512 根近期真实 K 线，另测 BTC 上线附近 128 根 1h K 线。193 条临时特征通过同周期检索与后续图验证后，隔离库与临时目录立即删除。

上面那句「不启动历史同步」说的是**滚动订阅**，这一条至今没变；但「公共特征和覆盖均为 0」从 2026-09-11 起不再成立：`attachment.locate` 的按需建索引和 `history.universe` 的月档扇出都会往公共索引里写行，后者是人一条一条排的作业，不是订阅。下面是 2026-09-11 当天 1d 补跑和 4h 首轮扇出**都跑完之后**的实测，是那一刻的事实、不是承诺：

- `public_market.features` 已发布的行：4h 569915、1d 79374、1h 16394、30m 1881、3d 29。
- `public_market.coverage_segments` 的 1d 部分共 942 行，但**行数不是段数**：一个工作单元会给 64/128/256 三档窗口各建一个世代，而这张表按 `generation_id` 记，所以同一个 `(symbol, start_at, end_at)` 最多占三行。按单元去重后是 401 个单元、187 个品种，其中 221 个 `complete`、180 个 `partial`。拿 942 这个行数去分类会把同一个单元数三遍，得出来的结论是错的。
- 那 180 个 `partial` 单元分两种，两种都**不是**「重跑就能补上」：166 个是某品种最早的一段、`actual_start` 就是它的上线日期，照实截断；另外 14 个全部是 `2022-01-01..2024-01-01` 这一段（SOLUSDT、XRPUSDT、LTCUSDT、TRXUSDT 等），月档一个没掉、首尾都顶到范围两端，断的是中间——币安自己的 `2022-02` 归档只到 2 月 25 日、`2022-04` 归档从 4 月 3 日才开始，缺的 5 天在上游就没有。
- 4h 首轮扇出（作业 `9fcae645`）200/200 跑完，用时 1 小时 36 分，下了 4832 个月档，建 3729 个单元、跳过 914、失败 11，写入 506567 行特征。按单元去重后 **196 个品种、1408 个单元，全部 `complete`**，没有一个 `partial`——其中 193 个单元的 `actual_start` 晚于范围起点，那是上市晚，不是缺口。`features_usd_m_4h` 这个分区此刻 1607 MB。
- 那 11 条失败收敛成三类：`flat_chart_geometry` 10 条（3 个品种，K 线太平，几何特征算不出来）、`archive_not_available` 3 条（MARSCOINUSDT、PONSUSDT、哈基米USDT，上市太新还没有月档）、`archive_catalog_unavailable` 1 条（ASTERUSDT）。这四个品种一根都没进去，196 而不是 200 就是这么来的。
- **3d 至今没有扇出过。** 那 29 行是一次临时索引请求的副产品：只有 BTCUSDT、`bars_count=32`、范围 2026-03-15..2026-09-11。32 不在跨品种检索用的 64/128/256 三档里（`history.rs` 的 `LOCATE_WINDOWS`，`chart_search/repository.rs` 按它绑 `bars_count=ANY($6)`），所以这 29 行进不了刻舟求剑的候选池——但重温找得到它们，单品种那条路径（`history.rs:509`）不过滤 `bars_count`。这不是缺陷，是 3d 这一档还没排过扇出作业。
- `replay_bars` 131 行（一次性展示缓存，带 `expires_at`，与索引无关）；`history_subscriptions` 0 行。

## 质量：真实截图盲测（2026-09-11）

`ops/blind_test.py` 分两轨跑：合成轨拿库里已知答案的窗口重新截图回查（有真值），真实轨拿用户那 14 张真实截图跑（无真值，只能看分数落在哪）。要 Pillow，系统 `python3` 没有，用 `vision/.venv/bin/python ops/blind_test.py`。

结论按可信度从高到低：

- **0.80 是当下该用的信任阈值，不是 0.70。** 在合成轨上，0.80 放过 27/54 条 top-1 正确的，放过 **0** 条 top-1 错误的（共 150 条），也放过 **0** 条负对照（共 23 条，那些是库里根本没有对应结构的图）。降到 0.70 就不行了：负对照的分数中位数是 0.617，0.70 的通过带里已经坐着它们。宁可让一半正确答案说「不确定」，也不能让一条负对照冒充答案。
- **所有 14 张真实截图都落在 0.327–0.528。** 一张都够不到 0.80。所以对真实截图，系统今天诚实的回答是**「不知道」**，不是给一个排第一的品种。这既可能是索引广度不够（4h 才刚扇出完，1h/30m 还很薄），也可能是真实截图和合成截图之间有系统性的分布差，盲测本身分不开这两件事。
- **每一个命中率都是有条件的：11.8% 的合成样本在解析阶段就失败了**，它们从未进入打分。分母是「解析成功的那些」，不是「全部」。1h、30m、4h 的同品种数字样本太少，**不可用**，不要引用。
- 「八百万行」那个规模数字是**外推**，不是实测。

## 规模：验到哪儿为止

单分区 200 万行是实测验过的；维护成本的拐点出现在 66 万行附近（HNSW 索引重建和 `VACUUM` 的时间在那之后明显抬头）。**千万行以上没有验收过**，不要引用任何号称 TB 级或亿级的结论。

运维上有一条硬约束：重建 `public_market.features_*` 上的 HNSW 索引只能**串行**做，一次一个分区。Postgres 容器的 `/dev/shm` 是 1.0G，并行重建会在那里撞上限然后失败。

数字会过期，查询不会。要当下的实况，自己跑这几条：

```sql
SELECT timeframe, count(*) FROM public_market.features WHERE published GROUP BY 1 ORDER BY 2 DESC;
SELECT count(*) FROM replay_bars;
SELECT status, count(*) FROM history_subscriptions GROUP BY 1;   -- 滚动的历史订阅有没有开
-- 覆盖按单元算，不按行算；并把 partial 拆成「上市晚」和「上游归档有缺口」两类
-- 换 timeframe 就能看别的档
WITH u AS (
  SELECT DISTINCT ON (symbol, start_at, end_at)
         symbol, start_at, end_at, actual_start, status
  FROM public_market.coverage_segments WHERE market='usd_m' AND timeframe='1d'),
n AS (SELECT *, row_number() OVER (PARTITION BY symbol ORDER BY start_at) AS no FROM u)
SELECT status,
       count(*) FILTER (WHERE no=1 AND actual_start>start_at) AS listed_late,
       count(*) FILTER (WHERE NOT (no=1 AND actual_start>start_at)) AS other,
       count(*) AS units
FROM n GROUP BY status ORDER BY status;
-- 某一轮扇出的失败都是什么原因
SELECT f->>'code', count(*), count(DISTINCT f->>'symbol')
FROM public_market.universe_index_runs r, jsonb_array_elements(r.failures) f
GROUP BY 1 ORDER BY 2 DESC;
```

用户原图、记录和复盘保留。2026-09-10 的清理证据见 period-live-verification.json、public-history-cleanup.json——它们记的是那一天的状态，不是现在的。「币安全部历史已建成」的覆盖结论仍然没有发布，也不该发布：4h 一档 196 个品种不等于全部历史。
