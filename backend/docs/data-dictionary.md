# v3 数据分区与生命周期

| 数据 | 身份 / 生命周期 |
|---|---|
| calls / call_state | 原判断不可变；展示变更 revision 与草稿时钟独立 |
| attachments / call_attachments | 用户原字节及明确引用；kind 区分现场、补充、参考、查询。`kind` 是唯一可以事后改的列（`PATCH /v1/attachments/{id}`，只在 scene/supplement/reference 之间改；用途是人事后才看得准的判断，不是证据），0046 起 attachments 上的整行不可变触发器换成"只有 kind 可改"，字节、sha256、尺寸、上传时间照旧一格都动不得 |
| reviews / review_outcome_refs | 已发布复盘不可变，引用用户当时确认的 outcome IDs |
| review_queue_projection | 业务事务内更新的可重建队列状态；分类索引避免长期累计后逐条重算 |
| review_drafts / review_preferences | 可恢复草稿和稍后提醒，各自 CAS；正式发布不重写原话 |
| outcomes / outcome_heads | 原始结果、数据订正、规则回放；正式 head 有约束，data_revision 形成有序链 |
| assessments | 等待到期、缺输入、重试、能力缺失等处理状态，与交易结果分离 |
| manifests / manifest_migrations | 规则、位置和输入哈希；旧元数据通过显式迁移记录修复，不包含原始行情 |
| jobs / job_attempts / job_targets | 稳定去重身份、代次与租约、精确目标；尝试历史默认保留 30 天 |
| requests / request_refs | 内容哈希、幂等响应和类型引用；临时响应过期后保留最小标记 |
| image_embeddings | 私有、按 owner 和模型空间检索的派生图像特征 |
| similarity_sessions / search_result_refs | 查询/结果快照和引用；未保存默认 7 天，saved 的引用继续保护原图 |
| history_indexes / history_plans | 用户的构建意图、子范围、检查点及公共代引用；没有 OHLC |
| public_market.generations/features/generation_features | 公共合约派生数据；可重建、按代发布；未引用的未发布特征 7 天后有限批清理 |
| export_artifacts / export_pins / export_refs / export_runs | 导出状态、精确保护对象、分块校验和暂存目录登记；默认 7 天到期 |
| restore_receipts | 同一已校验归档的恢复完成身份，不允许覆盖无该回执的已有用户 |
| storage_objects | 原图发布 pending/ready/expired/purged 登记，异常遗留可有限批回收 |
| gc_schedule / owner_queue_turns | 清理和任务公平轮转；仅为内部运行数据 |
| api_keys | 哈希凭证、权限、到期、父凭证及撤销；明文不入库、不导出 |
| provider_budgets | 相同出口和合约产品的共享 REST 预算和封禁冷却 |
| tags / playbooks / episodes / set_snapshots | 版本定义、显式关联和冻结分析集合；不是事后覆盖历史证据 |

所有私有引用按 owner 查询并使用明确外键/关联表。删除不是扫描任意文本中的 UUID。行情 OHLC、逐笔成交、系统生成 SVG/PNG 不属于持久数据，禁止出现在上述表、队列、导出或日志中。原用户截图仍是长期保留的证据。

## v4（迁移 0020—0046）

| 模块 | 主表与语义 |
|---|---|
| 搜图 | `chart_analyses` 原图识别元数据；`chart_search_runs` 可取消任务和有来源坐标的结果；`image_index_status` / `image_reindex_runs` 明确旧模型切换进度 |
| 公共历史 | `public_market.instrument_lifecycles` / `catalog_versions` 合约事实；`history_availability` 原始文件存在和 checksum 边界；`source_revisions` 文件版本；`coverage_segments` 实际区间（截图定位任务按 market/symbol/timeframe + `status='complete'` + 区间包含，再按所在 generation 的 `body->>'window_bars'` 检查 64/128/256 三档是否齐全，来决定要不要现建索引）；`features` 30 分区（2 个 market × 15 个周期）派生向量、`feature_locator` / `generation_features` 归属。它们不存公共 OHLC |
| K 线周期 | 唯一真相源是 `scorebook_core::domain::interval::Interval`（`crates/core/src/domain/interval.rs`），全代码库不得再写第二份周期白名单。支持币安合约 klines 全部 15 个周期：`1m` `3m` `5m` `15m` `30m` `1h` `2h` `4h` `6h` `8h` `12h` `1d` `3d` `1w` `1M`，字符串一律沿用币安写法且**区分大小写**（`1m` 是一分钟、`1M` 是一个月）。对齐与币安一致：分钟/小时/`1d` 按 Unix 纪元整除，`1w` 开在周一 00:00 UTC，`1M` 开在每月 1 日 00:00 UTC 且长度不固定（28~31 天）。`3d` **不是**纪元整除：实测币安 3d 开盘日从不落在 `epoch_days % 3 == 0` 上——2023-08-16T00:00Z 起全部 USDⓈ-M 合约共用 `epoch_days % 3 == 1` 的那条网格（实测开盘 2026-09-05 / 09-08 / 09-11，2026-10-01 不是开盘、2026-09-29 与 10-02 才是），在此之前 BTCUSDT 走 `% 3 == 2`（实测 2023-01-01、2023-08-14），2023-08-14 那根是只有 2 天的短棒，锚点自此前移一天；`add_bars`/`bars_between` 按固定 3 天步进，跨越这根短棒时会差 1 根。另注：COIN-M 与 2023-08-16 之前的 USDⓈ-M 三日线其实是**按每个合约各自的上市首日**起算的（实测 BTCUSD_PERP ≡ 2、ETHUSD_PERP ≡ 0，同一天并不同格），`Interval::floor` 只有时间戳没有合约上下文，建模的是 2023-08-16 起的 USDⓈ-M 网格。`features` 的月线分区**表名**叫 `features_<market>_1mo`（PostgreSQL 未加引号标识符折叠成小写，`1M` 会与 `1m` 撞名），但分区键与 `timeframe` 列存的仍是币安原文 `1M`。限制：`criteria.trigger.interval_seconds` 的 `bar_close` 触发只认固定秒数周期，**月线（`1M`）不支持 bar_close 触发**，命中时返回 `trigger_interval_not_supported`；其余 14 个周期都可用 |
| 历史订阅 | `history_subscriptions` 声明和预算；`history_subscription_plans` 本轮有界计划；`history_plan_scopes` 冻结实际来源范围；`history_subscription_cursors` 每合约/周期/尺度的下个窗口起点 |
| 真实交易 | `exchange_connections` 账户声明；`exchange_credentials` 仅 Keychain 引用；`trade_imports` 不可变来源回执；`trade_fills` / `account_ledger_entries` 原币种 Decimal 流水；`account_asset_totals` 仅按新入库行更新的可重算汇总 |
| 持仓投影 | `position_seeds` 期初声明；`trade_books` 账本目录；`trade_projection_runs` / `heads` 已发布快照；`trade_book_snapshots` 固定大小账本快照；`trade_epoch_cycles` 共享闭合周期；`trade_cycles` / `trade_cycle_allocations` 周期与不可变分摊；`trade_projection_checkpoints` 断点。旧 segment 表在 0038 显式删除 |
| 导入与核对 | `exchange_sync_runs` 最近账户历史；`exchange_export_runs` / `reservations` / `resolutions` 导出额度与未知提交处置；`trade_reconciliations` 冻结账本版本的对账；`execution_links` / `execution_link_fills` 人工声明的执行关联 |
| T3 与复盘 | `trigger_watches` / `trigger_checkpoints` / `trigger_events` 常量聚合状态及触发；`assessment_source_plans` / `decisions` 显式 REST/归档源切换；`episode_reviews` / `refs` 已看证据；`submission_feedback` 提交时捕获；`tag_revisions` 和 `playbook_transition_details` 谱系与明确状态变化 |
| 正式统计 | `set_definitions` 规则定义；`set_runs` 单 SQL 快照时间；`set_sample_members` 冻结成员、结果头、代表性及排除原因；`set_group_metrics` 可分页分组；`baseline_runs` / `baseline_samples` B1；`verdict_requests` / `verdict_events` 人工裁决 |
| 知识 | `knowledge_sources` 仅业务来源视图；`knowledge_dirty` 事务 outbox；`knowledge_documents` / `knowledge_chunks` / `knowledge_embeddings` 可重建索引；`knowledge_index_watermarks` 进度；`knowledge_repair_cursors` 分批完整性巡检。dirty 未清除的文档不参与查询 |
| Chat | `chat_runs` 固定模型与任务；`chat_model_turns` 已确认返回；`chat_tool_calls` 确定性动作身份及结果；`chat_events` SSE 游标；`chat_source_refs` 版本引用与删除失效；`chat_tool_evidence` 为工具结果提供单独来源视图，不进入知识自索引。原图字节不进入这些表 |
| 重温回放 | `attachment_locations` 一张截图确认过的品种/周期/起止时间（同板块对比图上画的往往不是记录本身那个合约，所以 `POST /v1/attachments/{id}/locate` 可以按图指定 `symbol`/`market`/`interval`，缺的格才回落到记录；指定值写进 job 体，worker 读的就是它，复盘发布后的那次自动定位仍然只认记录本身），长期保存、不过期，回放窗口起点优先读它，`matched_by` 区分 `user`（本人拉框确认）和 `auto`（复盘发布后自动匹配写入），自动匹配只插入不覆盖，本人确认过的行永远不会被改写；自动匹配的把握门槛在配置里：`SCOREBOOK_AUTO_LOCATE_MIN_SCORE`（默认 0.85，即 `chart_match::rerank` 判定「同一张图」的分数线）和 `SCOREBOOK_AUTO_LOCATE_MIN_MARGIN`（默认 0.05，第一名必须比第二名高出这么多），两条都满足才写行，否则只把前三个候选放进任务结果交给本人挑；定位任务在检索之前会先保证 `[T0 − 3×256 根, T0 向下取整到周期]`（768 根）这段行情有索引，没有就在 worker 里同步补出64/128/256 三档、`stride_bars=1`、`candle-geometry-v2` 的特征，generation / coverage / published 语义与 `POST /v1/history/indexes` 相同但不写 `history_indexes` 行，结果记在 `jobs.result.index`（`built`、`feature_rows`、`range`）；它只围绕这一条记录的判断时刻发生一次，不订阅、不滚动、不扩范围，也只存向量和时间坐标，不存原始 K 线；`chart_setups` 该记录要画的整套指标（`ma`/`ema`/`boll`/`atr`/`volume`/`macd`/`rsi`），后端只存只校验形状，一个指标值都不算，前端自己画；`replay_bars` 每次回放临时落库的展示用 K 线，带 `expires_at`，退出回放即删、worker 每小时清理过期行，不进逻辑归档，统计/结算/检索不读它，0045 起多一列可空的 `volume`（VOL 副图要画它，判决从不读它，旧行留 null 等过期换掉）；`GET /v1/calls/{id}/replay?bars=none` 只交代舞台坐标（品种/市场/周期/窗口/判决/价位/标记/定位状态），不取数、不落缓存、不续 `expires_at`，给自己直连币安拉 K 线的前端用 |
| 品种目录 | `instrument_catalog` 币安合约清单，`GET /v1/instruments` 只从它读，REST 只负责刷新它：worker 每 6 小时刷一次（启动先刷一次，失败只记日志、不清空目录）。热度排序要的 24 小时成交额是实时的，拉不到就退回目录自己的顺序，响应里 `source` 变成 `cached`、`ordering` 变成 `trading_then_symbol`，并始终带上 `refreshed_at`（目录这份是什么时候刷的）；只有实时拿不到、目录也从来没刷进来过才 503 `instruments_unavailable`。成交额排名只在内存，不入库 |
| 备份 | `backup_configurations` 仓库和 Keychain 引用；`backup_runs` 上传和读回验证状态；`backup_protections` 导出原图保护；恢复不自动绑定外部凭证 |

schema 43 逻辑归档包含用户业务资产和派生计算依据，排除公共行情、公共可重建向量、凭证和备份密码。知识派生索引通过恢复后的 dirty 重新建立。活动 Chat 恢复后必须创建新任务；旧模型恢复走显式离线升级及重建。
