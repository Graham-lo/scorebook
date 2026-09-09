# Scorebook 前端

给直觉记分的交易知识库，这是它的界面部分。

一条记录 = 一次判断的完整发生过程，以判断时刻为锚：当时的 K 线图、当时说出来的
判断和它的逻辑来源、谁先触发谁（先有想法再去图上验证，还是先看到结构才有想法）、
后来市场给了什么答案、事后回看更好的打法和相比上次的变化。界面的每一处都围着这
件事转，记录本身必须一行就能完成——那一刻人在交易。

后端是同目录下的 `scorebook-backend`（独立仓库，两边不放在一起）。**功能以后端的
实现和文档为准**：后端说做不到的，这里就写做不到，不摆一个按不动的按钮。

---

## 跑起来

三个进程，都在本机。先起后端，再起前端。

后端（在 `scorebook-backend` 目录里）：

```bash
./ops/run.sh serve
```

```bash
./ops/run.sh worker
```

按图搜索里「按画面样子比」需要本机视觉模型，不开也能用（那时只有「按走势形状比」）：

```bash
python3 vision/server.py
```

前端（在这个仓库的 `app` 目录里）：

```bash
npm install && npm run dev
```

然后打开 <http://127.0.0.1:5178/>。

第一次跑要先有一份本机凭证和一个允许的来源地址：

- 凭证：后端 `ops/run.sh create-user local --token-file data/local-token`。
- 来源：后端的 `.env` 里 `SCOREBOOK_ALLOWED_ORIGIN=http://127.0.0.1:5178`，改完重启
  `serve`。后端逐字比对协议、主机和端口。

### 凭证是怎么处理的

浏览器只和本机开发服务器说话，走同源的 `/api`。凭证由 `app/vite.config.ts` 里的
开发代理在 **Node 进程**里读 `../../scorebook-backend/data/local-token`，逐个请求加
上 `Authorization`，再转给 `http://127.0.0.1:8787`。它不进打包产物、不进 HTML、不进
任何 `VITE_*` 变量，页面里翻不到它。

这套只够一个人在本机用。以后要多人，得换成真正的会话和每用户身份，不能共用一把
固定密钥。

不要用 `file://` 打开页面去连接口，也不要为了图省事关掉鉴权或放开所有来源。

### 命令

| 命令 | 做什么 |
| --- | --- |
| `npm run dev` | 开发服务器 + 同源代理，`127.0.0.1:5178` |
| `npm run build` | 先 `tsc --noEmit` 再打包 |
| `npm run check` | 只做类型检查 |
| `npm run test:integration` | 对着真后端跑集成测试（要求 dev 服务器和后端都开着）|

---

## 页面用到哪些接口

| 页面 | 做什么 | 接口 |
| --- | --- | --- |
| 首页 `#/home` | 一眼看懂这是什么、现在该做什么 | `GET /v1/calls`、`GET /v1/review-queue`、`GET /v1/episodes`、`GET /v1/playbooks` |
| 记录判断（顶栏「记录判断」） | 一行写完判断，可拖图 | `POST /v1/attachments`、`POST /v1/calls/preview`、`POST /v1/calls`、`POST /v1/calls/{id}/attachments`、`GET /v1/instruments` |
| 我的记录 `#/find` | 按原话、品种、周期、标签翻自己的记录 | `GET /v1/calls`、`GET /v1/review-queue` |
| 一条记录 `#/call/{id}` | 判断、截图、市场后来的答案、复盘 | `GET /v1/calls/{id}`、`GET /v1/calls/{id}/history`、`GET /v1/attachments/{id}`、`POST /v1/market/chart`、`POST /v1/calls/{id}/corrections`、`POST /v1/calls/{id}/revisions`、`POST /v1/calls/{id}/void`、`POST /v1/tags/links`、`POST /v1/episode-links` |
| 按图搜索 `#/search` | 用一张截图找像的画面；准备可搜的历史范围 | `POST /v1/attachments`、`POST /v1/similarity/search`、`POST /v1/similarity/feedback`、`POST /v1/history/search`、`GET/POST /v1/history/indexes`、`POST /v1/history/plans`、`GET /v1/history/plans/{id}`、`POST /v1/history/plans/{id}/control`、`GET /v1/jobs/{id}`、`POST /v1/jobs/{id}/retry` |
| 复盘 `#/review` | 待复盘清单、草稿、发布、提醒 | `GET /v1/review-queue`、`GET/POST /v1/calls/{id}/review-draft`、`POST /v1/calls/{id}/review-draft/publish`、`POST /v1/calls/{id}/review-draft/discard`、`POST /v1/calls/{id}/review-reminder`、`GET /v1/calls/{id}/history` |
| 局面类别 `#/archive`、`#/episode/{id}` | 同类局面归到一起 | `GET /v1/episodes`、`GET /v1/episodes/{id}` |
| 我的做法 `#/playbook` | 自己的打法和它的变化 | `GET/POST /v1/playbooks`、`GET /v1/calls` |
| 设置 `#/settings` | 这台机器现在能做什么；导出一份副本 | `GET /v1/capabilities`、`GET /v1/health`、`POST /v1/exports`、`GET /v1/jobs/{id}`、`POST /v1/jobs/{id}/retry`、`GET /v1/exports/{id}/manifest`、`GET /v1/exports/{id}/files/{name}` |

后端有、但界面上暂时没有入口的：`/v1/deletions*`、`/v1/similarity/sessions/{id}/save`、
`/v1/attachments/{id}/index`、`/v1/calls/{id}/replays`、`/v1/calls/{id}/outcome-revisions`、
`/v1/evaluations/preview`、`/v1/sets/*`、`/v1/knowledge/tools*`、`/v1/events`、`/v1/criteria`。

---

## 代码怎么分的

```
app/src/
  api/        每个接口一层薄封装；错误码在 errors.ts 里统一翻成人话
  data/       会话状态、时间与小数、只存定位信息的本机记事（prep / lastExport）
  features/   一个目录一块业务：capture / find / call / search / review / archive / playbook / settings
  ui/         能复用的零件：安全建 DOM、图片、弹层、动效、空状态
  styles/     tokens.css 是设计变量，patch.css 是在它之上的样式
```

几条自己给自己定的规矩：

- **不用 innerHTML 放内容。** 记录原文、标签、从截图里读出来的字都是不可信输入，
  一律走文本节点（`ui/dom.ts`）。图标是唯一的例外，走自己那道窄门。
- **术语说人话。** 界面上不出现 worker、lease、attempt、generation、向量维度这类
  后端内部字段，也不造只有作者看得懂的词。
- **做不到就说做不到。** 能力开关来自 `/v1/capabilities`，没做完的功能不摆按钮。
- **行情和图不落盘。** K 线和临时画出来的图只在内存里，尊重 `no-store`；本机只记
  「哪一段历史在准备」「上一次导出的编号」这类定位信息。

---

## 测过什么

`npm run test:integration`：**66 项通过，0 项失败**。它对着真后端跑，不 mock 任何
东西，覆盖记录与截图、复盘草稿与冲突、发布与提醒、历史分页、按图检索与两种描述子、
历史范围准备、导出与清单、凭证只在服务端、行情图不落盘。

在浏览器里手工走过并确认的：

- 复盘草稿离开再回来还在；两个标签页同时写会被拦住，两边的文字都保留。
- 结果变了之后再发布，会先让人看过新结果。
- 历史范围准备：一次装得下的走 `/v1/history/indexes`；装不下的（超过 5 万根 K 线或
  1000 个片段）走 `/v1/history/plans`，能暂停、继续、取消，刷新页面进度还在，卡住时
  给「再试一次」。
- 导出：交出去 → 进度 → 导好了（条判断 / 次复盘 / 张截图三个数字来自清单本身）→
  下载清单；失败时能「接着做」，接不上时「重新导一份」。用后端自带的
  `verify-export` 校验过导出目录：`{"status":"verified","rows":2498,"files":45}`。

---

## 后端现在还做不到的（界面上都写着）

- 正式统计还没有，所以这里不给任何看起来像胜率的数字。
- 对着记录提问还没接上，不会编答案。
- 交易所账户、成交导入没有。
- 币安全历史的覆盖和自动持续更新没有做完；能搜的只有已经准备好的范围。
- 自动认出截图里的区域、周期和根数还没有做，要自己框。
- 按走势形状搜索的匹配质量还没有系统验收过。
