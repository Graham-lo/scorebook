# Scorebook 前端

给直觉记分的交易知识库，这是它的界面部分。

一条记录 = 一次判断的完整发生过程，以判断时刻为锚：当时的 K 线图、当时说出来的
判断和它的逻辑来源、谁先触发谁（先有想法再去图上验证，还是先看到结构才有想法）、
后来市场给了什么答案、事后回看更好的打法和相比上次的变化。界面的每一处都围着这
件事转，记录本身必须一行就能完成——那一刻人在交易。

后端是同目录下的 `scorebook-backend`（独立仓库，两边不放在一起）。**功能以后端的
实现和文档为准**：后端说做不到的，这里就写做不到，不摆一个按不动的按钮。

本机现在跑的就是 v4：后端分支 `codex/deploy-scorebook-local`，`backend_version`
`0.4.0`，库结构到 `0041`，API 在 `127.0.0.1:8787`，页面在
<http://127.0.0.1:5178/>。按图索骥的两步、在记下来的东西里找、统计与裁决、历史
目录与订阅、对着记录提问，这些 v4 才有的路都是通的，可以直接点开看。**没有配的
是本机凭据那一类**：Chat 模型、交易所只读密钥、备份仓库口令。界面对这三样照实
说「还没配」，不摆成已连接，也不拿演示数据填。

---

## 跑起来

都在本机。先起后端，再起前端。

后端（在 `scorebook-backend` 目录里）：

```bash
./ops/run.sh serve
```

```bash
./ops/run.sh worker
```

几块本机模型是可选的，缺了对应的功能就照实说「没配」，不会降级成别的算法：

| 进程 | 缺了会怎样 |
| --- | --- |
| `python3 vision/server.py`（DINOv2，默认 8790） | 「按画面样子比」用不了，只剩「按走势形状比」 |
| `python3 text_encoder/server.py`（BGE-M3，默认 8791） | 「按意思找」用不了，按原话搜不受影响 |
| `native/ocr.swift` 编出来的可执行文件 | 认图读不出品种和周期，要自己填，不会靠形状猜 |
| Chat 模型适配器 | 「问过去的自己」明确报 `chat_model_not_configured` |

前端有两种起法，接口那一头是一样的，区别只在改代码之后要不要自己重打包。

**一、平时开发（有热更新）**，在这个仓库的 `app` 目录里：

```bash
npm install && npm run dev
```

**二、本机现在跑的这一份（没有热更新）**：后端的 `ops/serve-frontend.mjs` 把打好
的 `app/dist` 当静态文件发出去，同一个进程代理 `/api`。改了代码要先
`npm run build`，刷新才看得到——直接改源码是不会自己更新的。

```bash
npm run build
```

```bash
node ../scorebook-backend/ops/serve-frontend.mjs \
  --dist "$PWD/dist" \
  --token-file ../scorebook-backend/data/local-token
```

两种都开在 <http://127.0.0.1:5178/>，一次只能开一个。

第一次跑要先有一份本机凭证和一个允许的来源地址：

- 凭证：后端 `ops/run.sh create-user local --token-file data/local-token`。
- 来源：后端的 `.env` 里 `SCOREBOOK_ALLOWED_ORIGIN=http://127.0.0.1:5178`，改完重启
  `serve`。后端逐字比对协议、主机和端口。

### 凭证是怎么处理的

浏览器只和本机的这个服务器说话，走同源的 `/api`。凭证由服务器在 **Node 进程**里
读 `scorebook-backend/data/local-token`，逐个请求加上 `Authorization`，再转给
`http://127.0.0.1:8787`。`npm run dev` 走 `app/vite.config.ts` 里的开发代理，
`serve-frontend.mjs` 走它自己那段，两边都是同一个做法。凭证不进打包产物、不进
HTML、不进任何 `VITE_*` 变量，页面里翻不到它。

交易所的只读密钥和备份仓库的密码同理，界面一次都不碰：它们是后端 Keychain 里的
引用，前端只看得到「配没配」这个事实。

这套只够一个人在本机用。以后要多人，得换成真正的会话和每用户身份，不能共用一把
固定密钥。

不要用 `file://` 打开页面去连接口，也不要为了图省事关掉鉴权或放开所有来源。

### 命令

| 命令 | 做什么 |
| --- | --- |
| `npm run dev` | 开发服务器 + 同源代理，`127.0.0.1:5178`，有热更新 |
| `npm run build` | 先 `tsc --noEmit` 再打包到 `dist/` |
| `npm run check` | 只做类型检查 |
| `npm run test:integration` | 对着真后端跑集成测试（要求页面服务器和后端都开着）|

---

## 页面是怎么排的

主线只有一条：**记录判断 → 持续观察 → 查看结果 → 完成复盘 → 沉淀做法**。顶栏也
就照着这条线放四个入口，它们合起来就是一条记录的一生：

| 入口 | 路由 | 这一步在干什么 |
| --- | --- | --- |
| 今天 | `#/home` | 今天该做的那几件事，和这条线现在走到哪儿 |
| 记录 | `#/find` | 自己写下的判断，按原话、品种、周期、标签翻 |
| 找相似 | `#/search` | 用现在的走势去找过去像的那几次，再看它们后来怎么走 |
| 复盘 | `#/review` | 到点该看结果、该写复盘的那些 |

「记录判断」不是一个页面，是顶栏右边那颗主按钮（快捷键 ⌃⇧S），在哪一页都能按，
一行写完就收工。

其余的都在「更多」里，一个也没有删，每条都写着它是干什么的：实盘账本
`#/trades`、长期统计 `#/stats`、局面类别 `#/archive`、我的做法 `#/playbook`、
按意思找 `#/recall`、问过去的自己 `#/chat`、设置 `#/settings`。历史范围
`#/history` 挂在「找相似」下面，因为它只在准备可搜的历史时才用得着。老链接
一条都没有变，`#/call/{id}`、`#/episode/{id}`、`#/cycle/{id}` 照旧打开同一屏。

一条记录走到哪一步、下一步该做什么，全站只在 `src/data/flow.ts` 里判断一次，
页面只负责画。判断的依据全部来自后端已有的公开接口：前端不另算分、不另定分母、
不猜。

---

## 页面用到哪些接口

| 页面 | 做什么 | 接口 |
| --- | --- | --- |
| 今天 `#/home` | 一眼看懂这是什么、现在该做什么 | `GET /v1/calls`、`GET /v1/review-queue`、`GET /v1/episodes`、`GET /v1/playbooks` |
| 记录判断（顶栏主按钮 / ⌃⇧S） | 一行写完判断，可拖图 | `POST /v1/attachments`、`POST /v1/calls/preview`、`POST /v1/calls`、`POST /v1/calls/{id}/attachments`、`GET /v1/instruments` |
| 记录 `#/find` | 按原话、品种、周期、标签翻自己的记录 | `GET /v1/calls`、`GET /v1/review-queue` |
| 一条记录 `#/call/{id}` | 判断、截图、市场后来的答案、复盘、对上的成交 | `GET /v1/calls/{id}`、`GET /v1/calls/{id}/history`、`GET /v1/attachments/{id}`、`POST /v1/market/chart`、`POST /v1/calls/{id}/corrections`、`POST /v1/calls/{id}/revisions`、`POST /v1/calls/{id}/void`、`POST /v1/tags/links`、`POST /v1/episode-links`、`GET /v1/execution-links` |
| 找相似 `#/search` | 先认图，再拿它去比：自己的复盘库，或者已经准备好的公开历史 | `POST /v1/attachments`、`POST /v1/chart-analyses`、`POST /v1/chart-search/runs`、`GET /v1/chart-search/runs/{id}`、`POST /v1/chart-search/runs/{id}/cancel`、`GET/POST /v1/images/index`、`POST /v1/market/data`、`POST /v1/market/chart` |
| 历史范围 `#/history` | 公开历史的目录、已发布的覆盖、正在准备的进度 | `GET /v1/history/catalog`、`POST /v1/history/archive-catalog`、`GET /v1/history/coverage`、`GET/POST /v1/history/indexes`、`POST /v1/history/plans`、`POST /v1/history/plans/estimate`、`GET /v1/history/plans/{id}`、`POST /v1/history/plans/{id}/control`、`GET/POST /v1/history/subscriptions`、`POST /v1/history/subscriptions/{id}/control`、`POST /v1/history/subscriptions/{id}/budget`、`GET /v1/jobs/{id}` |
| 按意思找 `#/recall` | 在所有记下来的东西里按意思翻，展开读原文 | `POST /v1/knowledge/search`、`POST /v1/knowledge/source/slice`、`GET/POST /v1/knowledge/index`、`GET /v1/jobs/{id}` |
| 问过去的自己 `#/chat` | 对着自己的记录提问；要写进记录的操作先问过人 | `POST /v1/chat/runs`、`GET /v1/chat/runs/{id}`、`GET /v1/chat/runs/{id}/events`（SSE）、`GET /v1/chat/runs/{id}/events/page`、`POST /v1/chat/runs/{id}/cancel`、`POST /v1/knowledge/source` |
| 复盘 `#/review` | 待复盘清单、草稿、发布、提醒 | `GET /v1/review-queue`、`GET/POST /v1/calls/{id}/review-draft`、`POST /v1/calls/{id}/review-draft/publish`、`POST /v1/calls/{id}/review-draft/discard`、`POST /v1/calls/{id}/review-reminder`、`GET /v1/calls/{id}/history` |
| 长期统计 `#/stats` | 一次固定口径的清点：数了哪些、代表样本、六种状态、分组；人工裁决 | `POST /v1/statistics/runs`、`GET /v1/statistics/runs/{id}`、`GET /v1/statistics/runs/{id}/members`、`GET /v1/statistics/runs/{id}/groups`、`POST /v1/baseline-runs`、`GET /v1/baseline-runs/{id}`、`GET /v1/baseline-runs/{id}/samples`、`GET /v1/verdict-requests`、`POST /v1/verdicts` |
| 实盘账本 `#/trades`、`#/cycle/{id}` | 成交、持仓、对账、和判断对上的执行 | `GET /v1/trades`、`GET /v1/trade-cycles`、`GET /v1/trade-cycles/{id}`、`GET /v1/account-ledger`、`GET/POST /v1/exchange-connections`、`POST /v1/exchange-connections/{id}/control`、`GET/POST /v1/exchange-syncs`、`GET/POST /v1/exchange-exports`、`POST /v1/exchange-exports/{id}/mapping`、`POST /v1/exchange-exports/{id}/resolve`、`POST /v1/imports/csv`、`GET /v1/imports/{id}`、`POST /v1/position-seeds`、`GET/POST /v1/reconciliations`、`POST /v1/execution-links` |
| 局面类别 `#/archive`、`#/episode/{id}` | 同类局面归到一起 | `GET /v1/episodes`、`GET /v1/episodes/{id}`、`GET /v1/tags` |
| 我的做法 `#/playbook` | 自己的打法和它的变化 | `GET/POST /v1/playbooks`、`GET /v1/calls` |
| 设置 `#/settings` | 这台机器现在能做什么；导出一份副本 | `GET /v1/capabilities`、`GET /v1/health`、`GET /v1/criteria`、`POST /v1/exports`、`GET /v1/jobs/{id}`、`POST /v1/jobs/{id}/retry`、`GET /v1/exports/{id}/manifest`、`GET /v1/exports/{id}/files/{name}` |

后端有、但界面上暂时没有入口的：`/v1/deletions*`、`/v1/history/search`、
`/v1/calls/{id}/replays`、`/v1/calls/{id}/outcome-revisions`、
`/v1/evaluations/preview`、`/v1/sets/*`、`/v1/knowledge/tools*`（问答内部在用，
人不直接调）、`/v1/events`、`/v1/sessions*`、`/v1/backups*`。
`/v1/similarity/*` 界面上也没有入口：找相似的两条路（比自己的截图、比公开历史）
现在都走 `chart-search`，只有集成测试还对着 `/v1/similarity` 跑。

---

## 后端还缺的契约（界面为此绕了路）

这三条是这一版做界面时撞上的。前端没有在浏览器里另建一份真相，只是多打了几次
请求或者少说了一句话，等后端补上就能删掉：

1. **复盘队列的一行不知道这条记录有没有标准，也不带结果摘要。**
   `GET /v1/review-queue` 的每一行有 `assessments[].state`（判分作业跑没跑完）、
   `draft_revision`、`draft_saved_at`，但没有「当时写没写标准」，也没有一句
   「市场后来给的是什么」。复盘列表要显示这两样，只能对每一行再打一次
   `GET /v1/calls/{id}`。
2. **记录详情不说有没有一份没发布的草稿，队列的一行也不带截图。**
   `GET /v1/calls/{id}` 里没有草稿的位置——草稿状态只在队列那头有，所以从一条
   记录点进去时得再问一次队列。反过来，队列的一行没有可以直接用的截图附件 id，
   列表上要出小图就得逐行 `GET /v1/calls/{id}` 再取 `attachments`。两个方向都
   是 N+1。
3. **按意思找：片段的字节位置和读全文的接口对不上。**
   建索引时切的是 `"{kind}\n" + 正文的 JSON`，`start_byte` / `end_byte` 是在这
   串上量的；`POST /v1/knowledge/source/slice` 发回来的却只有正文那一段。两边
   差着 `kind` 加一个换行的长度，所以界面不敢拿片段的位置去定位全文里的高亮，
   只能整段展开让人自己看。

---

## 代码怎么分的

```
app/src/
  api/        每个接口一层薄封装；错误码在 errors.ts 里统一翻成人话
  data/       flow.ts（一条记录走到哪一步，全站唯一判断处）、会话状态、时间与
              小数、只存定位信息的本机记事（prep / query-context / lastExport）
  features/   一个目录一块业务：capture / find / call / search / history /
              recall / chat / review / stats / trades / archive / playbook /
              settings；大的那几块自己再拆成几个文件（search 拆成 run / hits /
              results / controls / image-pane / scope …）
  ui/         能复用的零件：安全建 DOM、图标、图片与灯箱、浮层、拖框、动效、
              空状态、确认、提示条
  styles/     tokens.css 是设计变量；app.css 按 base → shell → controls →
              surfaces → signals → records → review → discover → library →
              home → motion → responsive 的顺序引进来，后面的只覆盖前面的
```

几条自己给自己定的规矩：

- **不用 innerHTML 放内容。** 记录原文、标签、从截图里读出来的字、模型写的答案都是
  不可信输入，一律走文本节点（`ui/dom.ts`）。图标是唯一的例外，走自己那道窄门。
- **术语说人话。** 界面上不出现 worker、lease、attempt、generation、分区、HNSW、
  向量维度这类后端内部字段，也不造只有作者看得懂的词。交易所的内部枚举也一样：
  `TRADIFI_PERPETUAL` 在挑品种的列表上写成「永续 · 传统市场标的」。
- **做不到就说做不到。** 能力开关来自 `/v1/capabilities`，没做完的功能不摆按钮；
  「配好了」也不等于「验收过了」，两件事分开说。
- **不知道就不写 0。** 没算出来的数字留空并说明，不拿零填。
- **小数不在浏览器里重算。** 后端给的是十进制字符串，原样显示，不进 JS 浮点。
- **同一次动作重试复用同一把 `Idempotency-Key`。** 改东西按契约带
  `expected_revision` / `expected_generation`，版本冲突要人看过再决定，不盲重试。
- **相似是结构排序，不是胜率。** 按图索骥给的顺序不改名成概率或上涨机会；
  「之后的走势」只用来看，从不参与召回、打分和排序。
- **行情和图不落盘。** 公开 K 线和系统临时画出来的图只在内存里，尊重 `no-store`；
  用户自己传的截图属于他的资产，按附件接口正常展示。

---

## 测过什么

`npm run test:integration` 对着真后端跑，不 mock 任何东西。它覆盖：记录与截图、
复盘草稿与冲突、发布与提醒、历史分页、按图检索与两种描述子、历史范围准备、导出与
清单、凭证只在服务端、行情图不落盘，以及 v4 的几节——认图与 chart-search 两步、
按意思找与读全文的版本钉住、一次统计 run 的固定口径、问答在没接模型时是否照实报
`chat_model_not_configured`。**v4 那几节写的是「两条路都算通过」：接上了该能跑通，
没接上该给一个说得清的错误码；不许出现第三种——一个编出来的答案。**

对着 v4 跑的三份记录都在后端 `docs/` 里，谁也没有覆盖谁：

| 证据 | 结果 | 是什么 |
| --- | --- | --- |
| `frontend-integration-v4.json` / `.log` | 81 通过 / 3 失败 | 第一次对着 v4 跑。三条失败是测试自己的问题：向量还没算完就断言、统计成员多带了一个后端不认的参数、问答那节把「排队 + 缺能力」当成了同步错误 |
| `frontend-integration-v4-after-test-fixes.json` / `.log` | 106 通过 / 0 失败 | 改完这三条之后的那次 |
| `frontend-integration-v4-claude-rerun-2026-09-10.json` / `.log` | 106 通过 / 0 失败 | 这一版界面打包之后又跑了一遍，确认没有回退 |
| `frontend-integration-v4-claude-rerun-2026-09-10-final.json` / `.log` | 106 通过 / 0 失败 | 界面改动全部落地之后的最后一次复跑 |

三次都是后端 `ops/review_frontend_local.py` 跑的：临时建一个库、单独一份存储目录、
单独的端口，跑完把库删掉。**用户自己的记录、原图和复盘一次都没有当过测试素材。**

在浏览器里手工走过并确认的（v4 本机部署）：

- 全站从 320 到 1440 逐个宽度看过：横向不溢出，顶栏在 980 以下排成两行、400 以下
  让出搜索按钮，「更多」浮层不被裁掉，手机上输入框不小于 16px（不然 iOS 会自己
  放大整页且回不来），底部留出安全区。
- 记录判断这个浮层：窗口高就停在正中，窗口比面板矮就从上往下滚，滚得到底；没有
  图的时候截图框是留白，不摆占位插画。
- 深浅两套主题都看过（跟系统走，没有单独的切换开关）。
- 品种搜索：`mu` 第一条就是 `MUUSDT`；中文说「比特币」「以太坊」「狗狗币」
  「黄金」「白银」也能落到常说的那一个永续合约上。
- 复盘草稿离开再回来还在；两个标签页同时写会被拦住，两边的文字都保留。
- 结果变了之后再发布，会先让人看过新结果。
- 历史范围准备：一次装得下的走 `/v1/history/indexes`；装不下的（超过 5 万根 K 线或
  1000 个片段）走 `/v1/history/plans`，能暂停、继续、取消，刷新页面进度还在，卡住时
  给「再试一次」。
- 导出：交出去 → 进度 → 导好了（条判断 / 次复盘 / 张截图三个数字来自清单本身）→
  下载清单；失败时能「接着做」，接不上时「重新导一份」。用后端自带的
  `verify-export` 校验过导出目录：`{"status":"verified","rows":2498,"files":45}`。

---

## 还没有做到的（界面上都写着）

- 真实交易所账户、独立备份仓库、Chat 模型这三样本机都没有配。界面照实说「没配」，
  不摆成已连接。
- 200 张截图 / 60 个问题的盲测、两小时真实混合验收，都还没有对应的材料。这些不能
  靠前端的模拟数据填成「已验收」。
- 按走势形状搜索的匹配质量还没有系统验收过，后端自己也这么写
  （`image_structure_search.real_image_quality_validated` 是 `false`）。
- 币安全历史的覆盖不是全量：能搜到的只有已经发布的那些范围，目录里有不等于能搜。
  「暂不启动历史同步」指的是**滚动订阅**，这一条至今没变；但覆盖已经不是空的了——
  `attachment.locate` 的按需建索引、以及人一条一条排的 `history.universe` 月档扇出，
  都会往公共索引里写已发布的行。当下的实测行数见后端 `docs/history-search.md`，
  那里写的是某一刻的事实，不是承诺。
- 正式统计的口径已经有了，但那是「特定规则和历史范围下的参照」，不是策略预测，更不
  是胜率。

## 2026-09-10 周期与历史测试更新

截图检索现在必须先选定周期，只比较同周期。历史准备支持读取已核实上线时间至最新收盘的范围，选范围不自动下载。按用户要求暂不启动历史同步。真实小范围测试已通过，测试库/临时目录及主库演示公共历史索引已经清理；当时公开历史覆盖为空是预期状态（2026-09-11 起不再成立，见上一节）。用户记录、原图和复盘保留。详见后端 docs/period-live-verification.json、docs/public-history-cleanup.json 及桌面 Scorebook_Claude前端重构Prompt_v4.1.md。
