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
