# 数据模块与生命周期

所有私有表使用 owner_id 隔离；API 不能通过请求正文指定 owner_id。UUID 为资源 ID，用户可读标识另行展示。

| 模块 | 表 | 事实与可变范围 |
|---|---|---|
| 身份 | users、api_keys | 密钥只存 SHA-256；full/read_only；凭证不导出 |
| 请求 | requests | 操作范围内幂等键、请求摘要、响应；删除时清理关联内容，保留防重墓碑 |
| 记录 | calls、call_state | 原文/原始参数冻结；revision/voided 为可重建展示状态 |
| 证据 | attachments、call_attachments | 用户原始图片哈希与时间身份；物理文件在受控 owner/id 目录 |
| 追加 | events、reviews | 更正请求、复盘、作废等追加，不修改原文 |
| 分类 | tags、call_tags | 标签定义版本、别名及 hot/cold 归类；不改变评分 |
| 情境 | episodes、episode_links | 固定首条锚点、120h 建议范围；建议与确认分离 |
| 打法 | playbooks、playbook_events、adoptions | 版本父链、状态事件、计划引用；不凭引用自动判断已执行 |
| 规则/结果 | rules、manifests、outcomes | 规则及结果冻结；manifest 只保留口径、时间和输入摘要，不保存行情序列 |
| 合约 | instrument_catalog | 币安合约元信息及刷新时间；不是 OHLC 行情仓库 |
| 图片索引 | embedding_models、image_embeddings | 模型身份、裁剪区域、向量、质量提示；原图可重建特征 |
| 历史索引 | history_indexes、history_windows | 任务范围、实际覆盖、合约/周期/起止窗口、向量、来源摘要；无 OHLC/raw/image 字段 |
| 检索 | similarity_sessions、similarity_feedback | 查询参数、候选来源、排序与反馈；用户原话副本纳入删除传播 |
| 集合 | set_snapshots、verdicts | 固定成员及可展开统计，规则分组；人工裁决完整流程后续补齐 |
| 后台 | jobs、outbox | 工作租约/重试；outbox 为 Telegram 后续接口预留，目前不发送 |
| 删除 | deletion_requests、tombstones | 短时确认令牌哈希、范围、最小墓碑；物理清理独立任务 |

`market_snapshots` 在迁移 0005 删除。旧开发阶段 manifest 中 bars/trades/base/atr0/end_price 被移除，并标记不能离线重放。已有用户原文和原图不受此迁移影响。

持久化系统只保存知识库证据、业务结果、元信息与派生索引。用户上传的图可以含行情；禁止把系统按 REST 重建的 OHLC 或图表自动写回附件仓库。
