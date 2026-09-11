# Claude 前端对接 Prompt · v3

请把现有 Scorebook 前端接入这个版本的真实 Rust 后端，并完成主要流程测试。你负责前端视觉和交互：精致、克制、苹果风，视觉与细节体验优先。请先阅读本项目的 review-experience.md，把长期复盘作为第一优先级。

后端目录是本机的这个仓库，远程 `https://github.com/Graham-lo/scorebook-backend`，分支 `codex/backend-reliability-performance-v3`。前端目录 `~/zhk/scorebook-frontend`，Claude 原型 `local.html`。只在已有用户设计基础上做模块化对接，不重置用户改动，不把旧演示数据当真实功能。前端是否已有工程/Git 以现场检查为准。

先读 README.md、docs/status.md、docs/review-experience.md、docs/api-workflows.md、docs/history-search.md 和 contracts/openapi.json。DTO 在 crates/core/src/api，用例在 crates/infrastructure/src/application，HTTP 在 crates/http/src。OpenAPI 请求类型真实生成，部分响应仍是通用 JSON，需要结合这些用例和集成测试确认字段。

## 连接与通用约定

API 默认 `http://127.0.0.1:8787`。本地开发凭证在后端 `data/local-token`，仅由本机服务端代理/BFF 读取，不得打印、提交、写入 HTML 或 VITE_* 构建变量。浏览器走同源代理；未来多用户以各自登录身份委派会话，不共享这个管理员开发凭证。会话接口 `/v1/sessions` 支持权限缩小及到期、撤销，但还没有完整的注册/密码登录/OIDC 页面。

业务请求带 Bearer。JSON 通常返回 `{data,meta}`，失败返回 `{error:{code,message,field,retryable,retry,request_id}}`。图片、SVG、归档文件是媒体流。时间传 UTC ISO 8601，按用户时区展示；价格/比率保留 Decimal 字符串。

配置 `SCOREBOOK_ALLOWED_ORIGIN` 为实际前端 origin 后后端支持明确的 CORS；优先同源开发代理，不删除鉴权、不放开任意来源。不使用 file:// 页面接 API。

每次用户持久化操作产生 Idempotency-Key；网络重试复用相同键和正文，内容变化才换键。不能收到超时就当成没保存。普通变更用服务端 revision，草稿和提醒有独立版本。409 保留输入并解释冲突，不静默覆盖。所有分页必须遍历游标，不用第一页计算全库统计。

## 第一优先级：长期复盘

严格实现 docs/review-experience.md。至少完成：

- 待复盘 / 继续填写 / 已完成 / 稍后处理队列；保留筛选、滚动和当前记录；列表变动不抢输入焦点。
- 原话、原图、当时判断条件与当前结果；没有标准也可以文字复盘。
- 草稿自动保存、服务器确认状态、关页恢复、网络重试、双标签页冲突和放弃草稿。
- 发布同时提交 `expected_draft_revision`、`expected_call_revision`、`expected_outcome_ids`；第三项是用户编辑时看到的结果列表，不能发布前偷偷换成新结果。
- `review_outcomes_changed` 时保留文字，提示有新结果，用户看过后再确认。正式复盘保留其 outcome_ids，展示历史时使用对应版本。
- 发布/丢弃之后 draft_revision 不归零。GET 草稿即使 draft=null 仍有版本号，下一次保存必须使用该值。
- 详情每类历史只返回最新 20 条；通过 `/v1/calls/{id}/history` 读取更早记录。注意详情数组与分页结果的排列方向，保持阅读锚点。
- 队列 reason 使用业务文案，不把代码枚举直接展示。提醒用业务文案，后台任务失败不展示为预测失败；缺输入、未到期、能力尚未开放分别解释。

`POST /v1/reviews` 也必须带 expected_outcome_ids。常规编辑路径优先草稿→发布。没有重新确认用户所见结果时，不能用直接发复盘绕过冲突。

## 截图搜索

支持拖拽、粘贴、文件选择、放大和图表区域选择。上传 `kind=query`，保留原图像素坐标传 region，避免把预览缩放坐标当成原始坐标。原图受鉴权保护，通过带 Bearer 的请求得到 Blob，再创建并及时释放 URL。

“我的复盘库”：`POST /v1/similarity/search`，model_id 可为 candle-profile-v1、dinov2-small-v1、hybrid-v1。Hybrid 要求两个模型均可用；失败不自动改模型。用户主动选择另一种模式是新的明确请求。`search_capacity_reached` 时保留查询，按服务端重试提示等待，不清空页面。

“币安历史走势”：`POST /v1/history/search`，模型明确选择 profile 或 DINO。通过 `/v1/history/coverage` 分页了解公共已发布覆盖；`/v1/history/indexes` 是自己的索引记录。长期范围准备使用 `/v1/history/plans`，控制接口支持 pause/resume/cancel 与 expected_revision。

结果显示“相似结构”，不解释为胜率或交易建议。保留查询图、裁剪区域和筛选。切换命中结果后，旧网络响应不能覆盖新的选中项。可通过 `/v1/similarity/sessions/{id}/save` 保存检索快照；未保存快照默认 7 天到期，无引用查询图 24 小时清理。

系统图用命中的 chart_request 调 `/v1/market/chart` 即时重绘。不要把返回的 K 线或系统图存入 IndexedDB、LocalStorage、Service Worker 缓存等持久缓存，也不要把系统图冒充原始现场图。不同品种统一币安合约目录，不能推断任意美股 ticker 都有行情。

## 其他接入与约束

记录原话、上传/补图、文字与标签别名搜索、打法版本、情境关联、集合快照、明确的删除预览/确认和导出均使用真实 API。分类统计目前是探索性能力，不做“已验证交易能力”的包装。正式原话不可编辑；修改判断创建关联修订记录。更正事件不会自动重算结果。

未来 Chat 使用 `/v1/knowledge/tools` 与 `/v1/knowledge/tools/call` 的工具契约，tool_call_id 必填且对重试稳定。当前仅交付工具基础，没有接云模型生成答案、交易所私有 API 导入和 T3 持续监控。不要展示伪聊天回复或伪交易记录；功能未开放时隐藏主操作或清楚说明。

界面不出现数据库、审计、worker、租约、attempt、generation、维度等工程字段。将 fetch、DTO/适配、业务状态、展示组件分模块，禁止在一个巨大页面里散落判断逻辑。

完成时请报告实际接通的流程、未接通的真实原因和测试结果。重点实测中文输入法、快速切换记录、双标签页、请求乱序、断网恢复、结果更新、长文/多图、时区、键盘导航与减少动画设置。视觉与交互验收由前端实际运行结果决定，不能仅凭后端测试称页面已经完成。
