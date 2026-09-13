# 品种边界索引（2026-09-13）

## 表与存储边界

迁移 `0056_instrument_bounds.sql` 新增 `public_market.instrument_bounds`，主键为 `(market,symbol,interval)`。字段为 `first_bar_at`、`last_bar_at`、`gaps`、`verified_at`，仅存时间标记，不含 OHLC、成交量或图像。`interval` 使用 `history::interval_of` 的币安原拼写，月线为 `1M`。

`market::data` 仍返回 `storage_policy=ephemeral;not_persisted`，2000 根上限与 `ChartRequest` 的 `deny_unknown_fields` 保持不变。`replay_bars` 仍为原有 24 小时临时缓存，退出清理；删除重温缓存不会删除边界索引。

## 写入规则

- 在 `application/market.rs::data` 的 REST 和月档成功响应后，以及 `application/replay.rs` 写 `replay_bars` 的位置观察已取得的行情；不为边界另发币安请求，不接受浏览器回传写入。
- `last_bar_at` 取本次所有已收盘根（`end <= server_now`）的最大开盘时间，使用 `GREATEST` 只向后更新。全部未收盘或空响应不会建立 last。
- 仅在 `coverage_complete=false`、首根 `start > 请求 start_at`、且请求起点早于目录 `onboard_at`（或 onboard 为空）时记录 first。使用 `LEAST` 只向前更新；空响应不建立 first。
- 仅在 `coverage_complete=false` 时记录有序 bars 的内部断口 `[前根.end,后根.start)`。不把请求外沿未覆盖部分记作内部 gap。
- `gaps` 为 `{start,end,seen_at}` 数组。迁移中的 SQL 函数 `merge_instrument_gaps` 合并相邻、重叠、嵌套和重复区间，按 start 升序，合并后的 seen_at 为最新观察时间。
- 使用一条 `INSERT ... ON CONFLICT ... DO UPDATE` 原子更新边界、合并旧/新 gaps 并刷新 `verified_at=now()`，防止并发覆盖。写入失败仅 warn，不改变行情响应。空响应可以刷新 verified_at，但 first/last 仍为 null 或保留既有值。
- replay 将实际补取窗口及其 coverage 标志传给缓存写入点，避免把整段舞台的起点当作补取起点。该路径同时经过 market::data，重复观察幂等，不重复取数。

这是已观察到的边界和缺口，不承诺已经扫描全部历史；后续完整窗口不会自动删除历史观察到的 gaps。

## 读接口

`GET /v1/market/bounds?market=usd_m&symbol=BTCUSDT&interval=1h`

三个参数必填，权限 `search.compute`。成功响应 `Cache-Control: private, max-age=60`；错误保持 `private, no-store`。

响应沿用 `{data,meta}`，data 包含：

```json
{
  "market":"usd_m","symbol":"BTCUSDT","interval":"1h",
  "status":"active","onboard_at":null,"delivery_at":null,
  "first_bar_at":null,"last_bar_at":null,"gaps":[],
  "verified_at":null,"server_now":"2026-09-13T00:00:00Z"
}
```

以上为字段示例，不是实测结果。生命周期字段来自 `instrument_lifecycles`；尚无 bounds 行仍返回 200，三个索引时间为 null、gaps 为空。目录无品种返回 404 `instrument_unknown`，即使有观察标记也不伪造目录信息。

|校验|HTTP / code|
|---|---|
|market 缺失或非 usd_m / coin_m|422 `contract_market_required`|
|interval 缺失或不在白名单|422 `unsupported_interval`|
|symbol 缺失、空串或全空白|422 `symbol_required`|

`MarketBoundsQuery`、路由与响应 schema 登记在 `contract.rs` / `response_contract.rs`，五个可空时间字段明确允许 null，gaps 为对象数组，server_now 必填。HTTP 通过 core Action / infrastructure facade 调用 `application/market.rs::bounds`。

## 测试与部署记录

隔离库 `tests/instrument_bounds.rs` 覆盖：单调 first/last、first 的三个证据条件、空响应、全部/多个未收盘根、相邻/重叠/嵌套/重复 gaps、并发合并、写入失败降级、目录空索引与 404、三个 422（含缺参）、所有标准周期、权限与缓存头、请求/实际响应契约、重温缓存写入及清理后的边界保留。

- `sh ops/test.sh` 全 workspace 隔离库测试合计 **237 passed / 0 failed / 11 ignored**；原始日志按测试二进制分组统计，隔离库已删除。新增边界测试包含在总数内，单独运行原文：

```text
test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.67s
Isolated test database deleted.
```

- `cargo clippy --workspace --all-targets -- -D warnings` 零警告；原文 `Finished `dev` profile [unoptimized + debuginfo] target(s) in 12.12s`。
- `cargo build --release` 成功；原文 `Finished `release` profile [optimized] target(s) in 1m 32s`。
- `python3 ops/check-boundaries.py`：`Workspace dependency boundaries verified`；`git diff --check` 通过。
- 2026-09-13 05:54（Asia/Shanghai）执行 `launchctl kickstart -k gui/$(id -u)/dev.scorebook.api` 与 `dev.scorebook.worker`。api PID 71995 → 86641；worker PID 72027 → 86670，均为 running，进程命令为当前目录 `./target/release/scorebook serve/worker`。
- 部署库 `_sqlx_migrations` 的 56 / instrument bounds / success=true 已核验；新表仅有交接要求的 7 个字段。
- 本机 curl `GET http://127.0.0.1:8787/v1/health`：HTTP 200，`{"data":{"status":"ok","version":"0.1.0"},"meta":{"api_version":"v1"}}`。

### BTCUSDT 1h 实测（UTC）

使用 `data/local-token` 鉴权；不在文档、日志或命令行参数中输出 token。实测前读取一次 bounds 作比较，然后只 POST 一次行情，再 GET bounds。

```http
POST /v1/market/data
Content-Type: application/json

{"market": "usd_m", "symbol": "BTCUSDT", "interval": "1h", "start_at": "2026-09-12T17:00:00Z", "end_at": "2026-09-12T21:00:00Z", "source": "rest"}
```

行情 HTTP 200，返回 4 根（响应仅摘录时间及标志，不保存原始 OHLC）：

```json
{
  "status": 200,
  "bars_count": 4,
  "first_start": "2026-09-12T17:00:00Z",
  "last_start": "2026-09-12T20:00:00Z",
  "last_end": "2026-09-12T21:00:00Z",
  "coverage_complete": true,
  "storage_policy": "ephemeral;not_persisted"
}
```

```http
GET /v1/market/bounds?market=usd_m&symbol=BTCUSDT&interval=1h
HTTP/1.1 200 OK
Cache-Control: private, max-age=60
```

```json
{
  "data": {
    "delivery_at": "2100-12-25T08:00:00+00:00",
    "first_bar_at": null,
    "gaps": [],
    "interval": "1h",
    "last_bar_at": "2026-09-12T20:00:00+00:00",
    "market": "usd_m",
    "onboard_at": "2019-09-08T17:55:00+00:00",
    "server_now": "2026-09-12T21:54:32.071268+00:00",
    "status": "TRADING",
    "symbol": "BTCUSDT",
    "verified_at": "2026-09-12T21:54:32.044136+00:00"
  },
  "meta": {
    "api_version": "v1"
  }
}
```

实测前 `last_bar_at=2026-06-08T07:00:00+00:00`，实测后 `last_bar_at=2026-09-12T20:00:00+00:00`，确认推进至这次返回的最后已收盘根；verified_at 同步刷新。实测前已有 worker 的历史窗口观察，未清空或改写生产边界来造初始状态。`status=TRADING`、未来 delivery_at 均为目录真实值，未归一化为示例中的 active/null。first 仍为 null：这次近期窗口不能证明上市首根。

### 本轮文件与未验证范围

- 新增：`migrations/0056_instrument_bounds.sql`、`crates/core/src/api/market.rs`、`tests/instrument_bounds.rs`、本文件。
- 修改：`crates/core/src/access.rs`、`crates/core/src/api/mod.rs`、`crates/core/src/ports.rs`；`crates/infrastructure/src/facade.rs`、`crates/infrastructure/src/application/market.rs`、`crates/infrastructure/src/application/replay.rs`；`crates/http/src/lib.rs`、`crates/http/src/market_routes.rs`、`crates/http/src/contract.rs`、`crates/http/src/response_contract.rs`；`docs/claude-frontend-handoff.md`。
- 按用户单独指定的回填要求，仅在上层 `SCOREBOOK-HANDOFF-2026-09-12.md` 顶部本轮段落后追加 3 行完成状态。未修改/重启前端，未触及 scorebook 合并仓库或 zjh 项目。
- 原有 13 个未提交/未跟踪文件逐个 SHA-256 对照完全一致；未 stash、checkout、全仓格式化、commit 或 push。分支 `codex/deploy-scorebook-local`，HEAD 仍为 `94d3f972977c8b2227570ff2a6f31eeeef59e569`；本轮无新增提交号。
- 11 项原有 ignored 测试未强制执行（涉及实图/OCR、restic、5 万笔规模、真实币安归档/基准/WebSocket、本地语义编码器等），不计入通过数；具体清单在 `data/bounds-verification/checks.json`。
- 真实接口仅验证 usd_m BTCUSDT 1h REST 路径；未实测 coin_m、月档边界写入、上市首根或真实历史缺口。单调、空响应、未收盘及缺口规则通过隔离库合成行情测试验证；不将其描述为真实全历史验收。
- 未做前端全屏图表/IndexedDB、桌面/手机交互验收；未扫描全历史、未验收后台索引/校准完成度或长期稳定性。

本机原始测试/构建日志、进程/迁移核验、无 token/无 OHLC 的接口摘要保存在忽略目录 `data/bounds-verification/`。release SHA-256：`0242d691553b2cd0f3472c5edb37ff263fece5cc7f541b1e87c8994130554b03`。

