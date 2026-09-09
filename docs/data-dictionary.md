# v3 数据分区与生命周期

| 数据 | 身份 / 生命周期 |
|---|---|
| calls / call_state | 原判断不可变；展示变更 revision 与草稿时钟独立 |
| attachments / call_attachments | 用户原字节及明确引用；kind 区分现场、补充、参考、查询 |
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

## v4（迁移 0020—0041）

| 模块 | 主表与语义 |
|---|---|
| 搜图 | `chart_analyses` 原图识别元数据；`chart_search_runs` 可取消任务和有来源坐标的结果；`image_index_status` / `image_reindex_runs` 明确旧模型切换进度 |
| 公共历史 | `public_market.instrument_lifecycles` / `catalog_versions` 合约事实；`history_availability` 原始文件存在和 checksum 边界；`source_revisions` 文件版本；`coverage_segments` 实际区间；`features` 12 分区派生向量、`feature_locator` / `generation_features` 归属。它们不存公共 OHLC |
| 历史订阅 | `history_subscriptions` 声明和预算；`history_subscription_plans` 本轮有界计划；`history_plan_scopes` 冻结实际来源范围；`history_subscription_cursors` 每合约/周期/尺度的下个窗口起点 |
| 真实交易 | `exchange_connections` 账户声明；`exchange_credentials` 仅 Keychain 引用；`trade_imports` 不可变来源回执；`trade_fills` / `account_ledger_entries` 原币种 Decimal 流水；`account_asset_totals` 仅按新入库行更新的可重算汇总 |
| 持仓投影 | `position_seeds` 期初声明；`trade_books` 账本目录；`trade_projection_runs` / `heads` 已发布快照；`trade_book_snapshots` 固定大小账本快照；`trade_epoch_cycles` 共享闭合周期；`trade_cycles` / `trade_cycle_allocations` 周期与不可变分摊；`trade_projection_checkpoints` 断点。旧 segment 表在 0038 显式删除 |
| 导入与核对 | `exchange_sync_runs` 最近账户历史；`exchange_export_runs` / `reservations` / `resolutions` 导出额度与未知提交处置；`trade_reconciliations` 冻结账本版本的对账；`execution_links` / `execution_link_fills` 人工声明的执行关联 |
| T3 与复盘 | `trigger_watches` / `trigger_checkpoints` / `trigger_events` 常量聚合状态及触发；`assessment_source_plans` / `decisions` 显式 REST/归档源切换；`episode_reviews` / `refs` 已看证据；`submission_feedback` 提交时捕获；`tag_revisions` 和 `playbook_transition_details` 谱系与明确状态变化 |
| 正式统计 | `set_definitions` 规则定义；`set_runs` 单 SQL 快照时间；`set_sample_members` 冻结成员、结果头、代表性及排除原因；`set_group_metrics` 可分页分组；`baseline_runs` / `baseline_samples` B1；`verdict_requests` / `verdict_events` 人工裁决 |
| 知识 | `knowledge_sources` 仅业务来源视图；`knowledge_dirty` 事务 outbox；`knowledge_documents` / `knowledge_chunks` / `knowledge_embeddings` 可重建索引；`knowledge_index_watermarks` 进度；`knowledge_repair_cursors` 分批完整性巡检。dirty 未清除的文档不参与查询 |
| Chat | `chat_runs` 固定模型与任务；`chat_model_turns` 已确认返回；`chat_tool_calls` 确定性动作身份及结果；`chat_events` SSE 游标；`chat_source_refs` 版本引用与删除失效；`chat_tool_evidence` 为工具结果提供单独来源视图，不进入知识自索引。原图字节不进入这些表 |
| 备份 | `backup_configurations` 仓库和 Keychain 引用；`backup_runs` 上传和读回验证状态；`backup_protections` 导出原图保护；恢复不自动绑定外部凭证 |

schema 41 逻辑归档包含用户业务资产和派生计算依据，排除公共行情、公共可重建向量、凭证和备份密码。知识派生索引通过恢复后的 dirty 重新建立。活动 Chat 恢复后必须创建新任务；旧模型恢复走显式离线升级及重建。
