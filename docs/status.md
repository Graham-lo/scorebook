# v4 后端交付状态

2026-09-10，`codex/backend-personal-v4`。实施范围为 P1、P2、P3、P4、P5、P7。P6 已取消；前端和多用户产品功能不在范围内。2026-09-10 下午本机主服务已部署 v4，主库 schema 43；Claude 的前端已接入，当前按用户追加要求修复搜索体验。

2026-09-11 追加「重温回放」后端（迁移 0042）：`attachment_locations` 长期保存截图到真实行情的定位，`chart_setups` 保存该记录要画的均线/布林/ATR 形状，`replay_bars` 是每次回放临时落库、退出即删的展示缓存。这是 README「公共行情只在内存」原则的唯一例外：`replay_bars` 只服务一次展示，带 `expires_at`，`DELETE /v1/calls/{id}/replay` 立即删除，worker 每小时兜底清理过期行；统计、结算、检索都不读它。回放不写 outcomes、manifests、events，唯一会删的行是 `replay_bars`。

2026-09-11 追加「复盘走完自动匹配一次」（迁移 0043，主库 schema 43）：`POST /v1/reviews` 和引导复盘发布都在同一事务里，为该记录每张还没定位的场景截图入队一条 `attachment.locate` 任务；单飞完全靠 `jobs` 的 `UNIQUE(owner_id,kind,dedupe_key)`——自动触发的 key 就是附件 id，所以一张图自动只匹配一次，手动触发遇到 queued/running 的任务直接返回它（`deduplicated:true`）而不排第二条，没有另建锁表。任务复用 `chart_search` 的识别与检索（scope=binance_history，品种/周期由记录预填，`cutoff_at` 是判断时刻），top1 分数 ≥ `SCOREBOOK_AUTO_LOCATE_MIN_SCORE`（默认 0.85）且比 top2 高出 `SCOREBOOK_AUTO_LOCATE_MIN_MARGIN`（默认 0.05）才写 `matched_by='auto'` 的行，否则只把前 3 个候选放进 `jobs.result` 交给本人挑。自动任务只插入不覆盖：本人 `PUT location` 写下的行永远保留，任务返回 `already_located`。新增 `GET/POST /v1/attachments/{id}/locate`，`GET /v1/calls/{id}/replay` 在定位进行中多一个顶层 `locating`。回归见 `tests/auto_locate.rs`（5 项）。

2026-09-11 追加「定位前按需建索引」（§1.6b，无迁移，schema 仍 43）：`chart_search` 的候选只来自 `public_market.features`，而本机按用户要求没有启动历史同步，索引为空时定位永远只能得到 `candidates: []`。现在 `attachment.locate` 在搜索之前先保证这段行情有索引：范围是 `[T0 − 3×256 根, T0 向下取整到周期]`（768 根，与回放窗口同一口径，品种/周期取记录本身），先查 `public_market.coverage_segments` 里同品种同周期、`status='complete'`、且请求区间包含该范围的段在 64/128/256 三档窗口上是否齐全（档位读所在 generation 的 `body->>'window_bars'`），齐全就直接搜；不齐全就在 worker 里同步补：`history::validate` + `s.market.klines` 的 REST 分页 + `history::index_generation` 写特征，三档各建一次、`stride_bars=1`、`models=['candle-geometry-v2']`。不新建 `history.index` 任务、不经 HTTP，也不写 `history_indexes` 行；generation 键、coverage 段和 published 翻转与 `POST /v1/history/indexes` 完全一致（`history::index_range` 与 `index_bars` 共用 `index_generation`）。上市前区间按实际起点截断，`coverage_complete=false` 记成 `partial` 段而不算失败；交易所不可用按现有重试策略重试。（这一句 2026-09-11 仍然成立，但它的后果那天变了：写成 `partial` 的段从前会被 `index_generation` 开头那句 ready 短路永久冻在原地，再补也补不进去，现在补跑能把它升成 `complete`——见下文当日「建了一半的世代」一条。）`jobs.result.index` 记 `{built, feature_rows, range, windows, stride_bars, actual_start}` 便于回查。索引只存向量和时间坐标，原始 K 线仍然只在内存里过一遍，README 的「公共行情只在内存」原则不受影响。

真实记录实测（主库，附件 2f635b4d…、记录 a14dc89a…，2026-09-10）：第一次 POST locate 建出 3 个 generation、3 段 `complete` 覆盖（BTCUSDT/1h，2026-08-09T16:00Z–2026-09-10T16:00Z）和 1859 行已发布特征（64 档 705 行、128 档 641 行、256 档 513 行），`index.built=true`；第二次 POST 命中覆盖检查，`index.built=false, reason=already_indexed`，行数不变。结果仍是 `ambiguous`，但候选不再为空：top1 = BTCUSDT/1h 2026-08-10T07:00Z–2026-08-15T15:00Z（128 根，score 0.332），top2 = 2026-08-25T23:00Z–2026-09-05T15:00Z（256 根，0.084），top3 = 2026-09-03T11:00Z–2026-09-08T19:00Z（128 根，0.076），低于 0.85 门槛所以不写 `attachment_locations`。原因不是门槛：这张截图是**币安 App 的 30 分钟图**（截图里「30分」页签选中，x 轴 09-08 15:00 → 09-11 00:52 本地时间约 58 小时、检测到 116 根，正好 30m），而记录的 `timeframe` 是 `1h`，检索又是 `same_interval_only`，所以 1h 的索引里根本不存在这张图对应的窗口；另外 `interval_for` 也还不支持 `30m`。次要因素：识别区域 y=688 高 1581，跨到了成交量和 MACD 面板，`spacing_consistency` 只有 0.92；以及同品种候选在 `chart_search::public_candidates` 里最多保留 3 个，所以 1859 个窗口里只有 3 个进入精排。门槛未做任何调整。

2026-09-11 追加「刻舟求剑的索引广度：按月档把前 200 个品种灌进历史索引」（迁移 0048，新表都在 `public_market` 下，逻辑归档 `ARCHIVE_SCHEMA` 仍是 43）：新增 `history.universe` 作业，`jobs::enqueue_tx` 把它归在 `batch` 队列。**一条作业只做一个周期**，这是用户明确要求的：粗周期先跑完，刻舟求剑就能在那一档上工作，细周期是大头，什么时候跑由人决定。名单按「24 小时成交额名次 + 24 小时成交笔数名次」两项相加（Borda）升序，和相同按简称字典序（`application/instrument_popularity.rs`）——只看成交额，几笔巨鲸单就能把一个其实没人在交易的合约顶到名单前面；只看笔数又会挑出一堆碎单的小票。名单本身落库存档：`universe_snapshots` 记快照时刻、market、名单实际大小与候选池总量、排序口径，`universe_members` 记每个品种当时的名次、成交额（`quote_volume`，coin_m 是张数 × 合约面值）、成交笔数和两项各自的名次。ticker 是快照，前 200 名每天都在变，不存下来事后没人答得出「这一轮到底搜了哪 200 个、截止到哪一天」。作业进度写在 `universe_index_runs`：走到第几个品种（`symbol_no`/`current_symbol`）、这个品种第几段（`current_range`）、建了/跳过/失败多少单元、下了多少个月档、写了多少特征行、最近 50 条失败（`failures`）。

这条路只走 `data.binance.vision` 的月度归档，一次 REST 都不走：`adapters/binance_archive.rs` 全文没有一处 `budget.reserve`，S3 静态对象不吃 fapi 的限频配额——两百个品种、十年历史这件事能做，整个前提就是这一条。**一个月的 zip 只下载一次**：一段范围的月档并发下载、校验、解压、解析成内存里的 bars，然后直接交给 `history::index_generation`，64/128/256 三档窗口（`STRIDE=4`）各建一个世代；照抄 `index_range` 那条「一个请求自己再拉一次行情」的路，同一个月档会被下三到六遍。作业按 `STEP_BUDGET`（45 秒）一步把进度写下来、让出 batch 队列，下一步接着走——几小时的作业不该把队列一直占死，中途停最多丢掉正在做的那一个单元（续跑靠的是「世代 ready + 覆盖段 complete + 特征 published」这套永久标记，做完一个单元就有，下次扫到直接跳过；这套标记这一天改了判据，见下文「建了一半的世代」一条）。归档里缺一个月是常态不是错误（新币没上市、合约已下架、币安偶尔漏传），记进 `failures` 继续走，只有真的丢了作业租约（`lease_lost`）才停。一根 K 线都不落盘：这条路上唯一写行情内容的语句仍是 `INSERT INTO public_market.features`（向量 + 时间坐标），bars 出了作用域就没了，coverage 里 `"raw_market_storage":"none"` 是实话。这一轮**没有 HTTP 路由，openapi 里也没有条目**：作业靠直接往 `jobs` 插一行来排（kind `history.universe`，体里给 `market`/`interval`/`top`），入口是故意押后的，不是漏了。

2026-09-11 追加「都不是」（无迁移）：这是两件事，不要混成一件。刻舟求剑那一半（`application/chart_search/repository.rs`）改的是**这一轮的候选**：人否掉的窗口 id 以 `exclude` 传回来，写进 ANN 候选 CTE 的 `id<>ALL($7)`，**在 `LIMIT 3000` 之前生效**。放在后面滤得到的只是同一批答案的短版本——人否掉三条之后要的是补上三条新的，而不是在结果里留三个空位。`<>ALL('{}')` 恒为真，所以不给排除列表时这条 SQL 与从前逐字节相同；累加、先去重再看上限，上限 `MAX_EXCLUDE` 100 条，越界 422。重温那一半改的是**去哪儿找**（索引沿时间轴往更早的一段推），写在 `docs/replay-spec.md` §1.7，这里不重抄。两处服务的是同一条规矩：按下「都不是」必须去取没看过的数据、并且带着已经给人看过的那几条排除，绝不许把同一个查询原地再跑一遍。

2026-09-11 修「建了一半的世代被 ready 一票否决」（`a63bfbd`，无迁移）：**`generations.status='ready'` 这一件事不是永久标记，ready 且源范围真的建齐了才是。** 月档掉了几个的那一趟同样以 ready 收尾，只是覆盖记录里 `coverage->>'source_range_complete'` 是 `false`、覆盖段停在 `partial`。`index_generation` 从前一进门就问 ready，于是后面每一次补跑都在这一句上短路，把调用方刚下好的那批 K 线原样扔掉，那一段永远补不上。线上 1d 的账要按**单元**算而不是按行算（同一个 `(symbol, start_at, end_at)` 会给 64/128/256 三档窗口各建一个世代，而这张表按 `generation_id` 记，所以最多占三行；按行数分类会把同一个单元数三遍）：改之前 401 个单元里 204 个 `partial`，其中 167 个是合约上市晚、照实截断，本来就不该变成 `complete`，另外 37 个是月档掉了的，就这么冻在原地。这一改之后的第一轮补跑把 24 个单元实打实地升成了 `complete`；剩下 14 个全是 `2022-01-01..2024-01-01` 那一段，月档一个没掉、断的是中间——币安自己的 `2022-02` 归档只到 2 月 25 日、`2022-04` 从 4 月 3 日才开始，那 5 天在上游就不存在，重下多少遍都一样（实测数字见 docs/history-search.md「当前运行决定与验收」）。判据换成 `COMPLETE_COVERAGE`（`status='ready' AND coverage->'source_range_complete'='true'::jsonb`，用 jsonb 直接比而不是 `::boolean`，字段缺了或写进去的不是布尔都算不完整、不会中途抛错）。跟着动的一共四处，少一处这件事就白做：一是 `index_generation` 这句短路；二是紧跟其后的世代抢占，`status<>'ready'` 得跟着放开，否则刚放行的那些行会全部卡在抢占上报 `shared_index_build_in_progress`，比原来的毛病更糟（真建齐的世代仍旧抢不到，它在上面就短路返回了）；三是 `coverage_segments` 的写入从 `ON CONFLICT DO NOTHING` 改成 upsert，补跑才能把 `partial` 升成 `complete` 并刷新 `actual_start`/`actual_end`，反过来不行——`complete` 是永久标记，后来一次抖动的重试不许把它抹回 `partial`，所以带 `WHERE c.status<>'complete'`；四是 `build()` 里照世代查 ready 的那一句，即 `POST /v1/history/indexes` 这扇门，同样加上这半句，否则一个想重建上次建残那段范围的 POST 会一根 K 线都不拉就把 partial 的覆盖记录还回去，冻结还是冻结，只是换了扇门进。紧挨着它上面那句按 `history_indexes` 查 ready 的不动：那是这条 job 自己的幂等，崩溃重试要靠它把上一次的结果原样交回来。

`index_range` 的那一处短路是**故意留在原地**的唯一一处，就地写了注释说明：它是下载**之前**的短路，只有重温（`locate::ensure_index`）走这条路，K 线是 REST 一段一段拉的，续跑不要钱全靠那一句；而且那边范围短通常是合约上市晚，不是下载掉了段。回归见 `tests/auto_locate.rs`：同一个世代先递 80 根残缺的 bars + `complete=false`（段 `partial`、17 行特征），再递 96 根齐的（段升 `complete`、补到 33 行），第三次故意再递那 80 根残缺的——一步都不许走，覆盖记录与行数一个字节不变。

## 已实现

| 模块 | 当前实现 |
|---|---|
| P1 按图索骥 | 用户原图/ROI、Apple Vision OCR、192 维蜡烛结构、固定 DINOv2 视觉向量、私有库融合召回、64/128/256 历史窗口、方向约束 DTW、显式反向、候选去重、合并区间实时取数精排、可取消持久任务 |
| P2 历史覆盖 | Binance USD-M/COIN-M 当前与退市归档目录、SHA256 月档校验、真实上市/文件边界、分区 HNSW、批量建库、逐合约/周期/尺度游标、每轮目录增长与容量复核、暂停/恢复/取消、明确重校验与版本替换 |
| P3 交易复盘 | 只读账户 API、CSV 显式映射与整份格式预校验、历史导出额度预留及未知提交处理、COPY 批量账本、去重与来源冲突、Decimal 持仓周期、增量投影、双向/反手/币本位、期初未知、分币种汇总与对账、成交分摊详情、执行关联 |
| P4 正式复盘与统计 | T3 触发与冻结期限/ATR、断点监控、明确选择 REST 或逐日归档恢复、统计组成与结果版本冻结、代表样本/六状态/分组分页、250 日 T1 B1、人工裁决与打法版本、episode 和标签语义 |
| P5 知识与 Chat 基础 | 固定本地 BGE-M3 中文混合检索、全业务来源视图、事务 outbox、16 段断点写入、遗漏/损坏修复、来源版本与全文分页、确定性工具注册与结果引用、原图内存端口、持久 Chat 轮次/工具执行、权限复核、写入确认、SSE 与来源删除失效 |
| P7 长期保存 | Keychain 凭证端口、固定 Restic 加密引擎、30 分钟调度、冻结导出与原图保护、上传后读回校验、保留策略、空库隔离恢复、v19 归档显式离线升级、分批清理未发布投影 |

结构模型仅运行 `candle-geometry-v2`，完整搜图协议为 `chart-match-v2`。旧模型名只保留在历史证据、迁移和明确清理规则中；没有新模型失败退回旧模型的运行分支。v3 性能脚本只用于对应历史 checkout，v4 使用单独的验收脚本。

## 已取得的证据

- 百万派生向量、12 个市场/周期分区：实际候选 SQL 的 Recall@20 平均 99.58%，最低 95%；8 个并发 SQL 读者，P95 360.83ms。见 `ann-acceptance-v4.json`。这是数据库候选检索测试，不是截图语义质量测试，也不是完整搜图端到端耗时。
- 50,000 笔合成成交、100 次独立导入：每批只投影新增 500 笔；100 个账本快照、25,000 个闭合周期、50,000 个分摊引用。导入和投影共约 13.9 秒；250 页完整遍历无遗漏，分页 P95 30.28ms。见 `ledger-acceptance-v4.json`。
- 真实公开数据：BTCUSDT 2024-01 月档 1h 共 744 根；ADAUSDT 2024-01-01 aggTrades 逐日文件 checksum 与流式聚合；一条实时 REST B1 样本。公共原始数据均只在内存读取。
- 固定 BGE-M3 实际本地编码、中文语义召回和来源删除验证；Apple Vision 文本识别已用内存合成标牌验证。两者均不替代真实用户样本盲测。新搜图链路另用内存合成行情验证 OCR → 候选 → 重取 → 精排与来源订正排除，修复 OCR 输入管道 EOF 超时后，两次查询合计约 1.93 秒（受控数据，不能作为真实网络 P95）。
- 真实 Restic 本机临时加密仓库、上传后读回、混合原图/成交/资金流水/持仓快照隔离恢复及错误密码拒绝通过。v19 格式归档的显式升级恢复通过，旧原话不改写。
- 最终全工作区 85 项非外部测试、格式/Clippy/依赖边界检查通过；独立 release 构建与 13 项真实 HTTP 冒烟通过，见 `release-smoke-v4.json`。这不是两小时混合压力验收。
- 完整 250 日 B1 受控测试覆盖未来观察排除、断点和重试不重复；原有与新增 PostgreSQL 集成测试覆盖幂等、故障、租约、取消、删除和复盘版本一致性。

## 尚未接通或未通过的外部验收

1. **真实 Chat 模型未选择和配置。** 当前生产适配器明确返回 `chat_model_not_configured`。现有工具编排已通过脚本模型验证，不能表述为真实模型已接通。
2. **没有真实交易所账户凭证或历史账单。** 账户适配器与合成流水通过测试；未验证用户实际账户的盈亏/手续费/资金费一致性。
3. **没有独立备份目的地。** 本机临时仓库恢复通过；尚未证明设备损坏情况下的恢复、真实 RPO/RTO。
4. **没有 200 张真实截图标注集和 60 个真实问题验收集。** 不宣称截图命中率、nDCG、真实问答质量和目标完整搜图 P95 已达标。
5. WebSocket 真实网络验证遇到 TLS handshake EOF，尚未通过。REST 和显式归档路径的验证不代表 WebSocket 已接通。
6. 尚未完成计划要求的**两小时真实混合运行验收**，也未发布“币安全部历史已建成”的覆盖结论。合约目录存在不等于每个窗口已发布。

因此，本分支具备六模块的后端实现与可重复验证基础，**不应标为全部真实接入、全部质量验收完成**。`GET /v1/capabilities` 区分实现、配置和验收；配置存在也不代表连通性已通过。

## 数据与恢复边界

用户原图、原话、复盘与真实成交是资产。公共 OHLC、aggTrades 和系统行情图不进入数据库、任务、日志、Chat 或备份；只存派生特征、摘要、来源哈希和窗口坐标。币安行情为参考市场，绝不覆盖真实成交价格。币安删档或订正后，系统说明来源变化，不能承诺无行情副本时仍离线复现。

主库已完成 0041 迁移；迁移前数据库与原图已在隔离库验证恢复，随后切换 API/worker 并完成图像与知识重建。部署细节见 `deployment-v4.md`，新增搜索与工作流要求见 `requirements-local-2026-09-10.md`。

## 2026-09-10 周期与历史测试更新

截图检索现在必须先选定周期，只比较同周期。历史准备支持读取已核实上线时间至最新收盘的范围，选范围不自动下载。按用户要求暂不启动历史同步。真实小范围测试已通过，测试库/临时目录及主库演示公共历史索引已经清理；当时公开历史覆盖为空是预期状态（2026-09-11 起改为：滚动的历史订阅仍未启动，但 `attachment.locate` 会围绕判断时刻现建一段有界索引，见上文 §1.6b 条目；同日又加了 `history.universe` 的月档扇出，公开特征和覆盖都已经不是空的，实测数字见 docs/history-search.md「当前运行决定与验收」）。用户记录、原图和复盘保留。详见后端 docs/period-live-verification.json、docs/public-history-cleanup.json 及桌面 Scorebook_Claude前端重构Prompt_v4.1.md。

2026-09-11 修「上游自己缺的，别罚我们重下」（`a6c4922`，无迁移）：月档扇出这条路上「建齐了」从前和 `archives::build` 共用一条判据——首尾顶到请求范围、中间没有断口。可 `unit.keys` 本来就是 `months()` 从币安自己的目录里列出来的那些月，这条判据于是在拿源头的事实当我们的失败算。上一条修好之后的第一轮补跑把能补的 24 个单元都补上了，剩下 180 个单元（166 个合约上市晚、14 个撞上 `2022-02` 只到 25 号 / `2022-04` 从 3 号才起那个截断）一个都过不了，意味着往后每一轮扇出都要把它们重下重建一遍，而重下一万次也变不出那五天。判据收缩成一条 `unit_complete(failed) = failed.is_empty()`：**源头列出来的月档我们一个没掉，就算建齐。**洞是源头的属性，不是我们的失败。这不是把话说圆了糊过去——跨断口的窗口早就被跳掉并记在 `windows_skipped_for_gaps` 里，段里到底有什么也照实写在 `actual_start` / `actual_end` / `source_bars_fetched` 上，改的只是「还要不要再来一次」这一个决定。建了一半的当月冻不进来：`months()` 只列币安已经传上去的月档，`units()` 又把 `end > now` 的整块跳掉，含当月的那一块 `to` 必然大过当月序号、`end` 至少是下个月一号，所以当月既落不进 `[unit.start, unit.end)` 也进不了 `unit.keys`（`the_month_still_running_never_lands_in_a_unit` 钉住这一条，因为把永久标记盖到半个月上比原来这个毛病更糟）。

这一改动了 `coverage_segments.status='complete'` 在**月档来源**上的含义，从「这段没有洞」变成「源头有的都在里面」，有两处跟着变，都是有意留下的，不是疏忽：

- **`GET /v1/history/coverage`**（连同模型工具 `list_history_coverage` 和 chat 工具 `history_coverage`）把 `generations.coverage` 原样交出去，扇出建的世代从此带着 `source_range_complete: true` 出现，尽管数据中间可能有洞。同一份 jsonb 里 `windows_skipped_for_gaps` 和 `actual_start`/`actual_end` 都在，所以它没有撒谎，但读这个字段的人得知道它现在回答的是哪个问题。
- **`locate::ensure_index` 的 `covered()`（history.rs:167）是一颗定时炸弹，现在还没响。** 它问的是「这段范围在 64/128/256 三档上都打过永久标记了吗」，打过就报 `already_indexed`、不再走 REST 去建——于是一段「月档没掉但中间有洞」的范围，重温以后不会再去补那个洞了，而那几天 REST 很可能是有的（归档截断和 REST 是两回事）。**眼下没有影响，因为扇出只跑了 1d**：`covered()` 要求覆盖段完整包住重温那 768 根的范围，1d 的单元是 24 个月（`months_per_chunk`：`24×28≥512` 且 `24×31≤4000`）最多 731 天，而 768 根 1d 就是 768 天，装不下；1h 单元一个月、768 根是 32 天，也装不下；4h(4 月/128 天)、2h(2 月/64 天) 同理，都差着几天。**30m 及更细的周期就装得下了**（30m 的单元一个月、768 根只有 16 天），所以等细周期的扇出真要跑之前，这里必须先处理。处理方式不是给 `covered()` 加一句「`windows_skipped_for_gaps` 必须为 0」——那会让重温在任何一段真有缺口的范围上永远重建，正是上面这两条刚修掉的那类毛病换个地方再犯一次。该做的是让它去问「我要的那个窗口在不在」，而不是「这段整体齐不齐」。

顺带把测试口子补上：`ops/run_tests.py` 从前跑的是不带 `--workspace` 的 `cargo test`，只覆盖根包和 `tests/`，`crates/infrastructure` 里的单元测试**一次都没跑过**（`universe.rs` 原有的三个用例也在其中）。加上 `--workspace` 之后 `scorebook_infrastructure` 的 18 个用例一并进入 `./ops/test.sh`。
