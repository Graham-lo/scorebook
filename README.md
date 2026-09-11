# Scorebook Backend

面向交易员长期记录、复盘和按图找走势的模块化 Rust 后端。当前分支实现 v4 的六个模块：截图检索、币安历史索引、真实交易账本、正式复盘统计、知识与 Chat 工具、加密备份。P6、前端和多用户产品功能不做。

Rust / Axum / Tokio / SQLx；PostgreSQL 17 + pgvector。公共行情只在内存取数、计算与重绘；用户原图、原话和真实交易是持久资产。唯一例外是重温回放：一次回放会把该记录窗口内的 K 线临时写进 `replay_bars`（带 `expires_at`），退出回放时 `DELETE /v1/calls/{id}/replay` 删除，worker 每小时清理过期行；它只服务一次性展示，统计、结算与检索一律不读它。只使用币安实际存在的 USD-M/COIN-M 合约，实际成交价与参考市场价分开。

**Mac 本机已部署 v4，页面入口 http://127.0.0.1:5178/，主库 schema 43。真实 Chat 供应商、真实账户和独立备份目的地尚未接通。** 已通过的测试与未通过的验收逐项见 [实施状态](docs/status.md)，不以接口数量表示完成率。

- [本机联调新增需求与流程规格](docs/requirements-local-2026-09-10.md)
- [部署与恢复](docs/deployment-v4.md)
- [前端对接说明](docs/claude-frontend-handoff-v4.md)
- [复盘状态与交互协议](docs/review-experience.md)
- [实施计划](docs/implementation-v4.md)
- [数据字典](docs/data-dictionary.md)

接口以 `GET /openapi.json` 和 [静态契约](contracts/openapi.yaml) 为准。UTC 时间戳、Decimal 字符串、Bearer 认证和幂等键保持统一。每次有状态修改按对应 revision/generation 校验。

| 能力 | 入口 |
|---|---|
| 原话、附件与复盘草稿 | `/v1/calls`、`/v1/attachments`、`/v1/calls/{id}/review-draft` |
| 截图分析与统一搜图任务 | `/v1/chart-analyses`、`/v1/chart-search/runs` |
| 历史目录、计划、订阅 | `/v1/history/catalog`、`/v1/history/plans`、`/v1/history/subscriptions` |
| 真实成交、周期与资金流水 | `/v1/imports`、`/v1/trades`、`/v1/trade-cycles`、`/v1/account-ledger` |
| 只读账户同步与历史账单 | `/v1/exchange-connections`、`/v1/exchange-syncs`、`/v1/exchange-exports` |
| 正式统计、B1、人工裁决 | `/v1/statistics/runs`、`/v1/baseline-runs`、`/v1/verdict-requests` |
| 中文知识与 Chat | `/v1/knowledge/search`、`/v1/knowledge/source/slice`、`/v1/chat/runs` |
| 重温回放（真实 K 线舞台） | `/v1/calls/{id}/replay`、`/v1/calls/{id}/chart-setup`、`/v1/attachments/{id}/location` |
| 截图自动定位（复盘发布后跑一次） | `/v1/attachments/{id}/locate`（GET 查看、POST 手动触发），`attachment_locations.matched_by` 区分自动与本人确认 |
| 即时重绘与能力状态 | `/v1/market/data`、`/v1/market/chart`、`/v1/capabilities` |
| 加密备份、恢复与删除 | `/v1/backups`、CLI `recover-backup` / `restore`、`/v1/deletions` |

## 代码边界

| 目录 | 唯一职责 |
|---|---|
| `crates/core/src/domain/` | 纯函数：显式语法、Decimal 评价、日历、样本统计、绘图 |
| `crates/infrastructure/src/application/` | 按功能拆分的用例；记录、复盘、历史索引、检索、结算、导出、删除、模型工具 |
| `crates/infrastructure/src/adapters/` | PostgreSQL、文件存储、币安 REST、本地图像特征服务 |
| `crates/http/src/` | 按用例分组的 HTTP 适配、认证、契约，不复制业务规则 |
| `vision/` | 独立模型进程与依赖；不把 PyTorch 装进 Rust API 进程 |
| `migrations/` | 追加式数据库升级；历史迁移保留，最新迁移体现不存行情的要求 |
| `tests/` | 领域边界、真实 PostgreSQL 集成、真实本地模型连通测试 |
| `ops/`、`docs/` | 运行、恢复、验证、架构和实际完成状态 |

新增功能在自己的应用模块实现，再由 HTTP 和模型工具调用同一用例。禁止在模型层/前端复制评分、绕过用户隔离或直接拼接任意 SQL。

## 测试

```sh
# 首次创建专用测试数据库
docker compose exec -T postgres psql -U scorebook -d postgres -c 'CREATE DATABASE scorebook_test;'
ops/test.sh
# 先启动本地模型，再跑真实视觉模型用例
ops/test.sh --features vision-tests
```

测试只会在库名以 `scorebook_test` 开头的数据库上运行（`tests/common/mod.rs` 断言），带着 `.env` 主库 URL 直接跑 `cargo test` 会被拒绝。

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --features vision-tests -- -D warnings
```

集成测试必须使用专用数据库，不会静默跳过数据库测试。当前实现、实测结果与仍未完成的验收见 [docs/status.md](docs/status.md)。

## 2026-09-10 周期与历史测试更新

截图检索现在必须先选定周期，只比较同周期。历史准备支持读取已核实上线时间至最新收盘的范围，选范围不自动下载。按用户要求暂不启动历史同步。真实小范围测试已通过，测试库/临时目录及主库演示公共历史索引已经清理；当前公开历史覆盖不再长期为空：历史同步仍未启动，也不订阅、不滚动，但截图定位任务（`attachment.locate`）在搜索之前会围绕这条记录的判断时刻现建一段有界索引——`[T0 − 3×256 根, T0 向下取整到周期]`，64/128/256 三档窗口、stride 1、`candle-geometry-v2`，只落特征向量和时间坐标，原始 K 线依旧只在内存里过一遍就丢。用户记录、原图和复盘保留。详见后端 docs/period-live-verification.json、docs/public-history-cleanup.json 及桌面 Scorebook_Claude前端重构Prompt_v4.1.md。

## 2026-09-11 周期扩容：币安全部 15 个合约 K 线周期

后端不再只有 6 个周期。截图检索、历史索引、回放、定位、归档、features 分区一律支持币安 USDⓈ-M / COIN-M 合约 klines 的全部 15 个周期：

`1m` `3m` `5m` `15m` `30m` `1h` `2h` `4h` `6h` `8h` `12h` `1d` `3d` `1w` `1M`

周期字符串沿用币安写法并且**区分大小写**：`1m` 是一分钟，`1M` 是一个月。唯一真相源是 `scorebook_core::domain::interval::Interval`（`crates/core/src/domain/interval.rs`），解析、对齐、根数算术、归档目录段、PostgreSQL 步长都从这里出，代码库里不再有第二份周期白名单。对齐与币安一致：分钟/小时/`1d`/`3d` 按 Unix 纪元整除，`1w` 开在周一 00:00 UTC，`1M` 按日历月开在每月 1 日 00:00 UTC。

`migrations/0044_all_binance_kline_intervals.sql` 为 `public_market.features` 的两个 market 各补齐 9 个新周期子分区；月线的物理表名叫 `features_<market>_1mo`（未加引号的 `1M` 会折叠成 `1m` 撞名），分区键与 `timeframe` 列存的仍是币安原文 `1M`。

已知限制：`criteria.trigger.interval_seconds` 的 `bar_close` 触发按秒数配置，月线长度不固定，**`1M` 不支持 bar_close 触发**（返回 `trigger_interval_not_supported`），其余 14 个周期均可用。
