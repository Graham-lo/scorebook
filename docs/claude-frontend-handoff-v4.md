# Claude 前端对接 Prompt：Scorebook v4

请基于 `codex/backend-personal-v4` 的最终接口契约对接已有 Scorebook 前端，不改后端业务规则。先读取 `contracts/openapi.yaml`、`docs/status.md`、`docs/review-experience.md` 和本文。前端和多用户体系不属于本轮后端改造；P6 已取消，不做采集桥、Telegram 或周报。视觉、细节体验优先，交易员长期复盘为核心，保持已有精致设计；不要呈现工程后台、审计和运维仪表盘。

## 先核对环境

本分支尚未部署到本机主服务；当前 8787 上的 Scorebook 主服务仍是 v3。不要把 v4 的新接口错误误判为前端逻辑问题，也不要自动切换到旧接口或旧算法。v4 API/worker 和模型进程按 `docs/deployment-v4.md` 配好以后再真实联调。能力状态来自 `/v1/capabilities`，配置存在不表示外部接入已验收。

## 统一规则

- UTC RFC3339 时间，金额与比例按接口的 Decimal 字符串读取，不能用 JS 浮点重算后覆盖账本结果。
- 成功 envelope 为 `{data, meta:{api_version:"v1"}}`。错误包含稳定错误码；结合 409 冲突、缺参数、能力未配置、来源不完整设计清晰的恢复操作。
- 同一次用户动作重试必须复用 `Idempotency-Key`。修改操作按契约发送 `expected_revision` / `expected_generation`；不要用盲重试覆盖版本冲突。
- 凭证放本机服务层或同源 BFF，前端不获取交易所/API/备份密码。
- 不使用演示答案、估算盈亏或“未返回就成功”补齐真实状态。

## 复盘工作区

记录原话、当时截图、后来复盘、系统正式结果和结果订正分别呈现，时间语义清楚。原话和原图不可原地修改。草稿自动保存、恢复、放弃、发布走现有 review-draft 协议；结果变化需要按用户真正看过的 outcome 版本重新确认。不要通过前端复制一套评分公式。

真实交易显示成交价、手续费币种、资金费与持仓轮次；币安行情作为参考图层。未知期初、未平仓、来源不完整与对账差额不能显示成零。轮次详情从 `/v1/trade-cycles/{id}` 继续翻页读取所有分摊，资金费等独立走 `/v1/account-ledger`。关联交易与判断是回顾性关联，不能伪装成开仓前证据。

## 按图索骥

1. 上传用户原图，保留附件 ID；提供可调整的原图像素 ROI。
2. `/v1/chart-analyses` 返回识别参数和限制。品种、周期不明确时让用户补充，不能根据形状猜币种。
3. `/v1/chart-search/runs` 创建任务，明确 private 或 binance_history。默认保持走势方向，反向必须由用户主动选择。
4. provisional 仅是候选；最终结果才完成来源哈希核验与几何精排。失败、取消、来源订正和覆盖缺口分别处理。
5. 按结果的 `chart_request` 调用 `/v1/market/data` 或 `/v1/market/chart` 实时重绘。必须保留其中的 `source`；退市归档结果不能自行改成 REST。
6. 不在浏览器离线缓存公共 OHLC 或系统生成行情图。原截图属于用户资产，可按附件接口展示。
7. 相似度是结构匹配排序，不能改名为胜率或上涨概率。尚无真实截图盲测验收结果。

## 历史范围

合约目录、已发布覆盖与建库进度是三种不同概念。界面用“已覆盖范围/正在扩展/暂不可用”等交易员能理解的状态。容量预算与恢复操作可放设置，不把分区、HNSW、租约等实现细节带入复盘主流程。订阅新增合约与各尺度独立推进，不能用全局 cycle 时间当作“全部历史已完成”。

## 正式统计和知识

统计按固定 run 展示组成记录、代表样本、六种状态与分组；跨页保持同一 run。B1 是特定规则和历史范围的参照，不是策略预测。人工裁决和打法状态变更必须是用户明确动作，模型建议不能直接变成裁决。

知识检索采用 `/v1/knowledge/search`。来源片段不等于全文；长文用 `/v1/knowledge/source/slice`，保持相同 `source_version` 和 UTF-8 字节游标。来源已变更/删除时清楚提示并重新取证。

## Chat

`POST /v1/chat/runs` 后订阅 `/v1/chat/runs/{id}/events`。SSE 断线带 `Last-Event-ID` 续读；不要再次创建任务。GET run 是当前权威状态。完成的回答按块和来源引用渲染，推断与事实区分。工具可能返回任务 ID，未完成时不能展示成已算好。

当前真实 Chat 供应商尚未选择，生产适配器返回 `chat_model_not_configured`。工具编排、引用和 SSE 已实现，脚本模型仅用于测试。不要把“已实现 Chat 接口”展示为“真实模型已开通”。写入提案要展示具体操作与内容，用户确认后携带原参数哈希和 user_intent，不能替用户自动批准。

## 重温回放（2026-09-11 新增）

五组接口，权限沿用现有 Bearer；写接口可带 `Idempotency-Key`（不是必填）：

- `PUT /v1/attachments/{id}/location` 体 `{symbol, market, interval, start_at, end_at, bars_count?, source, score?, search_run_id?}`，返回存入的行；`DELETE /v1/attachments/{id}/location` → 204。定位是**长期保存**的：一张截图确认一次，以后每次回放直接用，不要再发起按图找。`GET /v1/calls/{id}` 的 `attachments[]` 每项带 `location: {...}|null`，其中 `matched_by` 是 `"user"`（本人拉框确认）或 `"auto"`（复盘发布后自动匹配写入）。
- `PUT /v1/calls/{id}/chart-setup` 体 `{"ma":[20,50,200],"ema":[],"boll":null|{"n":20,"k":"2"},"atr":null|{"n":14}}`，返回 `{call_id, body, updated_at}`。后端只校验形状（元素为 1..500 的整数、均线加指数均线最多 6 条），指标由前端从 bars 自己算。`GET /v1/calls/{id}` 增加顶层 `chart_setup: body|null`。
- `GET /v1/calls/{id}/replay` 返回舞台数据：

```jsonc
{ "call_id","symbol","market","interval","source":"rest|monthly_archive",
  "window":{"start_at","end_at","bars_before","truncated","coverage_complete"},
  "judgment":{"at","base_price":"…"|null,"atr0":"…"|null},
  "levels":{"template","target_price","threshold_abs","invalidation_price","boundary_price","boundary_kind","trigger":{"kind","comparator","price","window_end_at"}|null,"horizon_end_at"},
  "marks":{"outcome_id","state","reason","trigger_at","trigger_price","first_threshold_interval","invalidation_hit","end_at","signed_return","mfe","mae","mfe_at","mae_at"}|null,
  "bars":[{"start","end","open","high","low","close"}],
  "locating":{"job_id","status"}|null,
  "storage_policy":"temporary;expires_at=…" }
```

  窗口起点 = 场景截图的 `location.start_at`，没有就是判断时刻前 120 根；终点 = `min(now, marks.end_at ?? levels.horizon_end_at ?? 判断时刻+120 根)`；总数封顶 2000 根，超出时从终点截断并置 `truncated:true`。`levels` 已按结算的同一套公式算好，**前端不要重算**；`marks` 为 null 表示还没有结果。品种/周期映射不到币安 interval 返回 `400 replay_interval_unsupported`，记录没有品种返回 `409 replay_needs_instrument`。
  `locating` 非空表示这条记录还没有定位、但有一个自动/手动匹配正在排队或运行：照常按默认窗口画，同时显示「正在定位」并轮询下面的 locate 接口，**不要**自己再发起 `chart.analyze` / `chart.startSearch`。
- `GET /v1/attachments/{id}/locate` → `{location: {...}|null, job: {id,status,result,created_at}|null}`，job 是这张截图最近一次匹配任务。`POST /v1/attachments/{id}/locate` 手动发起一次匹配，返回同样的形状外加 `deduplicated: bool`：已有 queued/running 的任务时直接把那一条还给你（`deduplicated:true`），**不会**排第二条。任务成功但没把握时 `job.result` 是 `{"outcome":"ambiguous","candidates":[前 3 个 HistoryCandidate],"min_score","min_margin"}`，把候选画成小图让本人点选，选定后仍旧走 `PUT /v1/attachments/{id}/location`（后端置 `matched_by:"user"`）。记录没有品种/周期时 POST 返回 `409 replay_needs_instrument`。
- 复盘发布（`POST /v1/reviews` 或引导复盘最后一步）成功后，后端会在同一事务里给这条记录每张还没定位的场景截图自动排一次匹配，一张图自动只匹配一次。所以复盘刚写完就进重温，多半已经在定位中——按 `locating` 显示进度，不要再点一次。
- **前端定位顺序固定，不能并行两条匹配**：① 有 `location` → 直接回放，什么都不发起，显示「已钉到 起–止」（`matched_by:"auto"` 的加一个「自动」小标）和「撤销」；② 没有 location → 先 `GET /v1/attachments/{id}/locate`，job 是 queued/running → 显示「正在定位」，每 2 秒轮询这个接口，定位出来后重新拉 replay；③ job succeeded 且 `outcome=ambiguous` → 画出 3 个候选让本人点「就是这一段」→ `PUT location`；④ 没有 job 或 job failed → 「钉到真实行情」按钮 → `POST /v1/attachments/{id}/locate`，然后回到 ②；⑤ replay 返回 `locating` 非空时等同 ②。本人不确认不写。
- `DELETE /v1/calls/{id}/replay` → 204。**离开重温页必须调用**（路由变化 / beforeunload，用 keepalive fetch）：这些 K 线是一次性展示缓存，退出即删；没调到的由 worker 每小时按 `expires_at` 兜底清理。不要把 bars 写进 localStorage / IndexedDB。

## 验收

覆盖：草稿中断恢复、结果更新冲突、重复提交、搜图取消与重试、部分历史覆盖、来源订正、CSV 重复导入、未知期初、币种费用、长列表翻页、Chat SSE 重连及引用失效。既有原图和原话不丢失，异常状态有明确下一步。

后端测试与性能证据见 `docs/status.md`。真实账户、独立备份、200 张截图/60 个问题盲测和两小时真实混合验收仍需对应材料，不能通过前端模拟数据填成已验收。
