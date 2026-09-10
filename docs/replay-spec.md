# 重温回放（relive / replay）规格 · 2026-09-11

设计与验收：Claude（本文件为唯一规格）。实现：后端一个 agent，前端一个 agent，并行。两边都按本文的接口契约写，不要各自改契约；契约有问题先改本文再改代码。

## 0. 产品目标

一条记录的展示页要做成「回忆模式」：舞台是**真实 K 线**（币安数据），不是截图。K 线先走到判断时刻停住，判断时刻的原话、方向、把握、标准里的价位钉在图上；然后一根根往后长，触发、失效、达标、到期、复盘时间点、成交都标注在同一张图上。截图退为角落里的对照小图。

展示规则（用户明确要求）：展示页只有图和事实标签，**没有任何引导句、解释小字、提示框**。引导文案只属于记录/复盘的填写流程。

## 1. 后端

### 1.1 存储策略（用户 2026-09-11 最终定稿：每次回放临时落库，退出即删）

用户的原话：「第一次肯定需要落库啊，落库才能按照截图精确匹配并且绘画，但是这是一次性的，第二次前端绘画时有了品种的相关信息，然后拿相关信息从币安取数据出来，这次不需要截图匹配了，拿到数据直接落地重绘，用户退出就删除。」

所以规则是：
- **每一次回放**都把这条记录窗口内的 K 线临时写进 `replay_bars`（带 `expires_at`）。第一次是为了按截图精确匹配并绘图；以后是拿永久保存的定位信息去币安取、落地、重绘。
- **用户退出回放就删**：前端离开重温页调用 `DELETE /v1/calls/{id}/replay`；worker 每小时清理过期行兜底（前端没来得及调 DELETE 的情况）。
- 它是一次性展示的暂存，不是行情库：统计、结算、检索一律不得读它。README 原则「公共行情只在内存」保留，把这个**唯一例外**写明；docs/status.md 同样写明。
- 「不需要存储 K 线数据」指的是**不长期存**，不是不落地。

### 1.1b 定位只匹配一次（用户要求）

`attachment_locations` 是**长期保存**的：一张截图第一次按图找精确匹配到品种、周期、起止时间并经用户确认后，就写进这张表；以后每次回放直接读它，不再重新按图匹配。它和 `replay_bars` 不同——`replay_bars` 每次回放写入、退出删除、过期清理，`attachment_locations` 永久保存不过期。`GET /v1/calls/{id}/replay` 的窗口计算必须先读 location；只有没有 location 时才退回「判断时刻前 120 根」的默认窗口。前端在有 location 时不得再发起按图找。

### 1.2 迁移 `migrations/0042_replay.sql`（追加式）

```sql
CREATE TABLE attachment_locations(
  owner_id uuid NOT NULL, attachment_id uuid NOT NULL,
  symbol text NOT NULL, market text NOT NULL CHECK(market IN ('usd_m','coin_m')),
  interval text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  bars_count int, source text NOT NULL CHECK(source IN ('rest','monthly_archive')),
  score numeric, search_run_id uuid, confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,attachment_id),
  FOREIGN KEY(owner_id,attachment_id) REFERENCES attachments(owner_id,id) ON DELETE CASCADE,
  CHECK(start_at<end_at)
);
CREATE TABLE chart_setups(
  owner_id uuid NOT NULL, call_id uuid NOT NULL, body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,call_id),
  FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE replay_bars(
  market text NOT NULL, symbol text NOT NULL, interval text NOT NULL,
  bar_start timestamptz NOT NULL, bar_end timestamptz NOT NULL,
  open text NOT NULL, high text NOT NULL, low text NOT NULL, close text NOT NULL,
  source text NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY(market,symbol,interval,bar_start)
);
CREATE INDEX replay_bars_expiry ON replay_bars(expires_at);
```

`chart_setups.body` 形状：`{"ma":[20,50,200],"ema":[],"boll":null|{"n":20,"k":"2"},"atr":null|{"n":14}}`。后端只校验形状（数组元素 1..500 的整数，最多 6 条线），不算指标。

### 1.3 接口

所有接口沿用现有 Bearer 认证、owner 隔离、UTC 时间戳、Decimal 字符串。写接口沿用幂等键约定（`Database::write/finish`）。加进 `crates/http/src/contract.rs` 的路由表和 `contracts/openapi.yaml`。

**`PUT /v1/attachments/{id}/location`** 体：`{symbol, market, interval, start_at, end_at, bars_count?, source, score?, search_run_id?}`。附件必须属于 owner。返回存入的行。**`DELETE /v1/attachments/{id}/location`** → 204。
`GET /v1/calls/{id}` 的 `attachments[]` 每项增加 `location: {...}|null`（在 calls.rs `get` 的 jsonb_agg 里加子查询）。

**`PUT /v1/calls/{id}/chart-setup`** 体 = body 形状；返回 `{call_id, body, updated_at}`。`GET /v1/calls/{id}` 增加顶层 `chart_setup: body|null`。

**`GET /v1/calls/{id}/replay`**（读，但会把窗口内的 K 线临时写进 `replay_bars`）
```jsonc
{
  "call_id": "...", "symbol": "BTCUSDT", "market": "usd_m", "interval": "1h", "source": "rest",
  "window": { "start_at": "...", "end_at": "...", "bars_before": 120, "truncated": false, "coverage_complete": true },
  "judgment": { "at": "...", "base_price": "…"|null, "atr0": "…"|null },
  "levels": {                          // 全部按 domain/criteria.rs 里 evaluate 的同一套公式算，前端不重算
    "template": "T1",
    "target_price": "…"|null,          // 方向型：base ± threshold（threshold_ratio*base 或 atr0*atr_multiple），按 direction 取符号
    "threshold_abs": "…"|null,
    "invalidation_price": "…"|null,
    "boundary_price": "…"|null, "boundary_kind": "…"|null,
    "trigger": { "kind": "...", "comparator": "gte|lte", "price": "…", "window_end_at": "..." }|null,
    "horizon_end_at": "..."|null
  },
  "marks": {                           // 来自 outcome_heads 的 claim 0 结果；没有就 null
    "outcome_id": "…"|null, "state": "realized|…", "reason": "…",
    "trigger_at": null, "trigger_price": null, "first_threshold_interval": null, "invalidation_hit": null,
    "end_at": null, "signed_return": null, "mfe": null, "mae": null,
    "mfe_at": "..."|null, "mae_at": "..."|null   // 在窗口 bars 里找到的极值所在 bar 的 start；找不到为 null
  },
  "bars": [ {"start","end","open","high","low","close"} ],
  "storage_policy": "temporary;expires_at=…"
}
```
- 品种/周期取记录 body 的 `instrument/market/timeframe`（timeframe 映射到币安 interval，映射不到 → `400 replay_interval_unsupported`）；没有品种 → `409 replay_needs_instrument`。
- 判断时刻 = `body.original_claimed_at ?? submitted_at`。窗口起点 = 场景截图有 location 就取 `location.start_at`，否则判断时刻前 120 根；终点 = `min(now, marks.end_at ?? levels.horizon_end_at ?? 判断时刻+120 根)`；总数封顶 2000 根，超了从终点截断并 `truncated:true`。
- bars 先查 `replay_bars`（同一次回放里前端可能多次请求，或上次退出没来得及删），缺的区间按 source 走现有 `market::data` 的取数路径（REST 分页或月度归档）从币安取，写入 `replay_bars`（`expires_at = now()+24h`），再返回。
- `base_price`/`atr0` 的来源和结算路径保持一致（看 `assessment_monitor` / `domain/watch.rs` 的 `submission_base` / `atr_at_submission` 怎么来的，用同一个来源；拿不到就 null，不要自己另算一套）。
- 不写 outcomes、manifests、events。

**`DELETE /v1/calls/{id}/replay`** → 用户退出回放时调用：删除这条记录窗口内的 `replay_bars` 行（按 market/symbol/interval/窗口范围），204。

**worker**：每小时 `DELETE FROM replay_bars WHERE expires_at<now()`，沿用现有 jobs/worker 的周期任务方式，作为前端没调 DELETE 时的兜底。

### 1.4 验收

- `cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings` 通过。
- tests/ 新增集成测试（真实 PostgreSQL，`ops/test.sh`）：location 的 put/get/delete 与 owner 隔离；chart-setup 形状校验；replay 的窗口计算（有 location / 无 location / 超 2000 截断）、levels 与 evaluate 公式一致、第二次请求命中 `replay_bars` 不再打交易所（用现有的 market adapter 测试替身）、DELETE 后该窗口 `replay_bars` 行为 0、过期清理。
- `cargo build --release`，然后 `launchctl kickstart -k gui/$(id -u)/dev.scorebook.api` 和 `dev.scorebook.worker`，`curl -s http://127.0.0.1:8787/openapi.json | grep replay` 能看到新路由。
- 不动工作树里已有的未提交改动（它们是 codex 的），只新增/追加。


### 1.5 行情可取范围：从上市到当下（用户 2026-09-11 补充）

- 币安可以取到一个品种从上市到当下的全部 K 线。回放的时间窗口逻辑**不得**因为判断时刻久远而拒绝、截断成空或退化成假数据。
- 缓存未命中时的取数路径：先走 `adapters/binance.rs::klines` 的 REST 分页（按 `startTime` 逐页，单次上限 50 000 根）；REST 不可用（451/超预算）或范围超限时走 `adapters/binance_archive.rs` 的官方月度归档（data.binance.vision），按月拼接。两条路径都已有实现，回放只做编排，不新写抓取器。
- 窗口仍按 §1.3 的规则裁到 2000 根并回 `truncated`，但裁的是「展示窗口」，不是「可取范围」：判断时刻在 2021 年也要能回放。
- 不确定取法时：先看本仓库两个适配器和 git 远程分支里的历史代码，再查币安文档。

### 1.6 复盘走完后自动匹配一次（用户 2026-09-11 补充；作为第二批任务，在 §1.1–1.5 完成后实现）

用户原话：「最好每次用户完整记录一条并走完复盘整个流程，就自动异步匹配一次，把永久标记记录下来，后面用户主动重温回放就快很多了，但是要注意当用户刚走完整个流程需要回放时，如果当时匹配正在跑那就不要再跑一次，这里面代码不要冲突。」

**触发点**：`review_workflow::publish`（引导复盘最后一步）和 `POST /v1/reviews` 成功提交之后，在同一事务里对这条记录的每张场景截图（scene 附件）检查：没有 `attachment_locations` 行 → `jobs::enqueue_tx(kind="attachment.locate", dedupe_key=<attachment_id>, body={call_id, attachment_id, trigger:"review_published"})`。记录没有品种/周期（body 里没有 instrument/timeframe）的不入队。

**单飞（不冲突）的实现**：全靠现有 `jobs` 表的 `UNIQUE(owner_id,kind,dedupe_key)` + `ON CONFLICT DO NOTHING`——同一张附件同一时刻只可能有一个 `attachment.locate` 任务在 queued/running。不另写锁、不另建状态表。规则：
- 自动触发的 dedupe_key 固定为 `<attachment_id>`：一张图**自动只匹配一次**，成功与否都不重复。
- 用户手动触发（下面的 POST）先查这张附件有没有 queued/running 的 locate 任务：有 → 直接返回那个任务（`deduplicated:true`），**不新建**；没有 → 用 dedupe_key `<attachment_id>:manual:<n>`（n = 该附件已终态的 locate 任务数）入队。
- 定位任务只写 `attachment_locations`（和 `jobs.result`）；回放接口只读 `attachment_locations`。两边没有共享的可写状态，所以不会互相覆盖。
- 用户手动 `PUT /v1/attachments/{id}/location` 永远优先：写入时 `matched_by='user'`；自动任务跑完发现已有行则不覆盖（outcome `already_located`）。

**任务执行**（worker，`jobs.rs` 的 dispatch 加 `"attachment.locate"` 分支，复用 `application/chart_search` 的 analysis 与 search 逻辑，scope=binance_history，symbol/market/interval 用记录 body 预填，`cutoff_at` = 判断时刻，等 final）：
- 取候选 top3。写入条件：top1 分数 ≥ 阈值，且 top1 与 top2 差距明显（两个阈值放配置，默认值以现有 chart_search 对「高相似」的标准为准，写在 data-dictionary）。满足 → 写 `attachment_locations`（`matched_by='auto'`，`score`、`search_run_id` 填上），`jobs.result={"outcome":"located",...}`。
- 不满足 → 不写 location，`jobs.result={"outcome":"ambiguous","candidates":[top3 的 HistoryCandidate]}`，任务算 succeeded。
- 已有 location → `{"outcome":"already_located"}`。
- 交易所不可用/超预算 → 任务按现有重试策略重试，最终 failed 并记 error_code。

**候选从哪来——按需建索引（§1.6b，必须做，否则本机上定位永远没有候选）**：`chart_search` 的候选只来自 `public_market.features`（64/128/256 根固定窗口的特征向量），而本机按用户要求**没有启动历史同步**，索引为空，于是自动定位、手动定位都只能得到 `candidates: []`。用户定的模型是「第一次肯定要落库，落库才能按截图精确匹配」，所以定位任务在搜索之前必须先保证这段行情有索引：
- 需要的范围：`[T0 − 3×256 根, T0 向下取整到周期]`（T0 = 判断时刻，与 replay 窗口同一口径），market/symbol/interval 取记录本身。
- 先查 `public_market.coverage_segments`（同 market/symbol/timeframe，`status='complete'`，且 `window_bars` 覆盖 64/128/256 三档）是否已完整覆盖该范围；已覆盖就直接搜。
- 没覆盖就在 worker 里**同步**补：复用 `history::validate` + `s.market.klines`（REST 分页；VPS 不是目标，本机可直连）+ `history::index_bars` 写特征，三档窗口各建一次，`stride_bars=1`（否则候选边界最多差 stride−1 根，写出的 location 起止不准）。范围 ≤ 1024 根，每档窗口数 ≤ 1000，满足 `validate` 的上限。索引只存向量和时间坐标，不存原始 K 线（README 的「公共行情只在内存」规则不受影响），因此不是「历史同步」——它只围绕这条记录的判断时刻，随定位任务一次性发生，不订阅、不滚动、不扩范围。
- 补索引失败（交易所不可用、上市前无数据）→ 任务按现有重试策略处理；上市前区间用 `coverage_complete=false` 的实际起点截断，不算失败。
- 建索引所用的 `history.index` 语义（generation、coverage 写法、published 标记）与现有 `POST /v1/history/indexes` 完全一致，只是不经 HTTP、不另起 job；`jobs.result` 里记 `index:{built:true|false, feature_rows, range}`，便于回查。
- 手动 `POST /v1/attachments/{id}/locate` 走同一个 `run`，因此同样受益。

**迁移**（追加 `migrations/0043_auto_locate.sql`，不改 0042）：
```sql
ALTER TABLE attachment_locations ADD COLUMN matched_by text NOT NULL DEFAULT 'user' CHECK(matched_by IN ('user','auto'));
```

**接口**：
- `GET /v1/attachments/{id}/locate` → `{ location: {...}|null, job: { id, status, result, created_at }|null }`（job 取该附件最近一个 locate 任务）。
- `POST /v1/attachments/{id}/locate` → 手动触发，规则见上；返回同样的形状，外加 `deduplicated: bool`。
- `GET /v1/calls/{id}/replay`：没有 location 但有 queued/running 的 locate 任务时，照常按默认窗口返回 bars，外加顶层 `locating: { job_id, status }`；前端据此显示「正在定位」并轮询 `GET locate`，定位完成后重新拉 replay。有 location 时 `locating` 为 null。
- `GET /v1/calls/{id}` 的 `attachments[].location` 带 `matched_by`。

**验收**：复盘发布后 jobs 里出现一条 locate 任务；索引为空时跑一次定位任务后 `coverage_segments` 出现该品种周期围绕 T0 的 `complete` 段、`features` 有三档窗口的行，真实记录 a14dc89a 的场景截图第二次 POST 后 `outcome` 不再因 `candidates: []` 而 ambiguous（要么 located，要么给出 top3 真实候选）；重复发布/连点不产生第二条；任务跑完 `attachment_locations` 出现 `matched_by='auto'` 的行（用测试替身返回一个高分候选）；替身返回两个分数接近的候选时不写行、result 为 ambiguous；任务 running 时调 POST locate 返回 `deduplicated:true` 且 jobs 行数不变；任务 running 时调 replay 返回 `locating` 非空、不新建任务；用户 PUT location 后自动任务不覆盖。

## 2. 前端

路由：`#/relive/<call_id>/<n>`，n = 1..5，一步一个网址（手机返回手势可用）。新文件 `src/features/relive/{index.ts,candles.ts,indicators.ts,locate.ts}`、`src/styles/relive.css`（加进 `src/styles/index.css` 的 import 链，放在 review 之后）、`src/api/replay.ts`。`main.ts` 里 `register('relive', relivePage)`。

### 2.1 五屏（每屏只有图 + 事实标签，零解说）

1. **回到那一刻**：K 线从窗口起点画到判断时刻停住，判断时刻之后一根不画。判断时刻竖线；线上挂方向徽章 + 把握分；原话做成钉在那一根上的气泡（超过 60 字截断，点开全文）。右下角截图对照小窗（有 scene 图才有），点开可全屏看原图。事实标签：品种、周期、日期时间。
2. **定下的标准**：`levels` 里的目标价、失效价、触发价、边界画成水平虚线（各自带价位标签，渐入动画），观察期 `horizon_end_at` 在时间轴上拉出一段刻度。没有标准就只有竖线，标签「没有定标准」。
3. **市场的答案**：按 → / 空格 / 点击「播放」，K 线一根根往后长（速度按周期：1m 20根/秒，1h 6根/秒，4h/1d 3根/秒，可 ×2/×4）。穿过 `trigger` → 打标；`invalidation_hit` 那一根 → 红标并停；`first_threshold_interval` → 停一下盖章；`end_at` → 盖章 + 结果数字（signed_return / mfe / mae）；mfe_at/mae_at 标最高/最低点。`marks` 为 null（还没结果）→ 播到窗口末尾，标签「还在等」。
4. **后来**：复盘的 `created_at` 在时间轴上落点，点开是那条复盘（note / better_play / vs_last）；关联成交（现有 trades / execution link 数据）画三角；supplement 截图有 location 就把它的窗口画成一段刻度，点开看图；同段行情（episode_links）里其它记录的判断时刻画小竖线。没有复盘 → 一个按钮「现在就写」进 `#/review/<id>/step/1`。
5. **全貌**：整段缩到一屏，所有标注都在；顶部一行结论：对/错盖章 + 数字；下面「当时 | 后来」两张截图对照（如有）。「再看一遍」「回到记录」。

### 2.2 K 线组件 `candles.ts`

纯 SVG，`h()` 构建，无第三方库。接口：`createCandles({bars, interval, levels, marks, judgmentAt, setup}) → {node, showUpTo(index), play(speed), pause(), setSetup(setup), zoom(range)}`。增量画：`showUpTo` 只追加新 bar 的 DOM，不重画全图。y 轴按当前可见区间 + 水平线一起算。价格线、标注、气泡各自一层。指标 `indicators.ts`：MA / EMA / BOLL / ATR 纯函数，从 bars 算。设置面板在舞台底部（勾选后 `PUT /v1/calls/{id}/chart-setup`）。手机：横屏优先，竖屏时图占上 60%，事实标签在下。reduced-motion：不播放，直接跳到终态。

### 2.3 截图定位 `locate.ts`（§1.6 落地后按本节更新）

顺序固定，不能并行两条匹配：
1. 有 `location` → 直接回放，什么都不发起。显示「已钉到 起–止」（自动匹配的加一个「自动」小标）+「撤销」。
2. 没有 location → 先 `GET /v1/attachments/{id}/locate`。job 是 queued/running → 显示「正在定位」，每 2 秒轮询这个接口，**不调 analyze / startSearch**；定位完成有 location → 重新拉 replay。
3. job 是 succeeded 且 `result.outcome=ambiguous` → 把 `result.candidates` 前 3 个画成小图让用户点「就是这一段」→ `PUT /v1/attachments/{id}/location`（`matched_by` 由后端置 user）。
4. 没有 job（从没跑过）或 job failed → 「钉到真实行情」按钮 → `POST /v1/attachments/{id}/locate`，然后回到第 2 步轮询。前端不再自己调 `chart.analyze` / `chart.startSearch` 做定位。
5. 回放接口返回 `locating` 非空时，等同第 2 步。

用户不确认不写。入口位置不变：重温第 1 屏、详情页「当时」一段的截图工具栏。

### 2.4 入口与收尾

- 详情页 `.callhead` 的 actionsRow 第一个按钮「重温一遍」（primary）；第 1 段截图工具栏「钉到真实行情」。
- 复盘队列每行「先重温再写」。
- 离开重温页（路由变化 / beforeunload，用 keepalive fetch）调用 `DELETE /v1/calls/{id}/replay`。
- 数据不进 localStorage / IndexedDB。
- `npm run build`（tsc 严格：noUnusedLocals）通过后 `pkill -f serve-frontend.mjs`，用 `curl -s http://127.0.0.1:5178/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.\(js\|css\)'` 确认新哈希。
- 视觉：沿用 tokens（青蓝 `--blue`、香槟 `--gold`、`--serif` 标题、`--mono` 数字），动效沿用 motion.css 的节奏；不要做成暗色工程风、扁平苹果风或安静纸本风。iPhone 390×844、iPad 820×1180 / 1024×1366、横屏 844×390 都要能用，无横向溢出。

## 3. 验收清单（Claude 执行）

1. 后端：clippy/fmt/tests 通过；openapi 含 4 条新路由（location put/delete、chart-setup put、replay get/delete）；schema 42。
2. `GET /v1/calls/a14dc89a-fadc-4ce5-b62b-4afc9eaabd66/replay` 返回 bars 且 `levels` 与该记录 head outcome 的 manifest 一致；调用后 `replay_bars` 有行，DELETE 后为 0 行。
3. 前端 5 屏在桌面、iPhone、iPad 各走一遍；页面上 `.tip`、解说句为 0；键盘 → ← Esc、手机滑动可用。
4. 截图定位流程：候选 → 确认 → 详情页 attachments[].location 出现 → 重温第 1 屏窗口起点变为 location.start_at。
5. 原话、原图、outcomes 无任何改动；`replay_bars` 过期清理生效。
