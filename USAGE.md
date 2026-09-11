# 使用文档

从一台什么都没有的 Mac 开始，把记分簿跑起来，然后按顺序走一遍它真正的用法。
这东西是什么、为什么这么做，见 [README.md](README.md)。

下文所有相对路径以仓库根目录为准。后端的命令都在 `backend/` 里执行，前端的都在
`frontend/app/` 里执行。

## 先备齐

- **macOS。** 不是随口一说：凭证存在 macOS Keychain 里，OCR 用的是 Apple Vision，
  服务托管在 launchd。别的系统上后端主体能编译，这几块不行。
- **Rust。** 工作区是 edition 2024，`rust-version = "1.88"`，所以工具链不低于
  1.88。
- **Node。** 前端是 Vite 6，配置里用了 `import.meta.dirname`，需要 Node 20.11 以上。
- **Docker。** 数据库用 `compose.yaml` 里钉死的 `pgvector/pgvector:0.8.2-pg17`
  起，映射到 `127.0.0.1:55432`。已经有自己的 PostgreSQL 17 + pgvector 也行，把
  `DATABASE_URL` 指过去即可，版本别往下降。
- **Python 3。** 只有可选的本机模型进程（DINOv2、BGE-M3）和 `ops/` 下的脚本用得
  到。不装的话那几项能力照实报「没配」，别的不受影响。

## 数据库

```sh
cd backend
cp .env.example .env
```

`.env` 里先把密码改掉，`POSTGRES_PASSWORD` 和 `DATABASE_URL` 里那一段必须是同一
个值，自己生成一个够长的随机串：

```
POSTGRES_PASSWORD=<generated>
DATABASE_URL=postgres://scorebook:<generated>@127.0.0.1:55432/scorebook
```

然后把库起起来：

```sh
docker compose up -d postgres
```

迁移不需要单独一步：`backend/migrations/` 下 48 个迁移文件被 `sqlx::migrate!`
编进二进制，`serve`、`worker` 和 `migrate` 任何一个启动时都会先跑一遍（
`crates/infrastructure/src/adapters/db.rs`）。想单独确认一次就在构建之后跑
`./ops/run.sh migrate`，它只打印 `Migrations applied.`。迁移是追加式的，历史迁移
不改写。

## 配置

`.env.example` 是模板，里面**一个密钥都没有**，这是有意的。要紧的几项：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | 上面那一条。测试不会用它，见下文测试一节 |
| `SCOREBOOK_STORAGE` | 用户原图和导出落在哪儿，默认 `./data`，就是本机令牌所在的那个目录 |
| `SCOREBOOK_BIND` | API 监听地址，默认 `127.0.0.1:8787`。不要往 `0.0.0.0` 上挪 |
| `SCOREBOOK_ALLOWED_ORIGIN` | 前端来源，逐字节比对协议、主机、端口。本机这一套填 `http://127.0.0.1:5178`，改完要重启 `serve` |
| `SCOREBOOK_EGRESS_ID` | 共用一个出口 IP 的所有 worker 必须填同一个值，限频预算按它算 |
| `SCOREBOOK_BINANCE_WEIGHT_PER_MINUTE` | REST 限频预算，默认 600。历史账单导出那一类要求 ≥1000，不主动开就别动它 |
| `SCOREBOOK_VISION_URL` | DINOv2 进程，默认不配。不配则「按画面样子比」明确报不可用，不降级 |
| `SCOREBOOK_TEXT_ENCODER_URL` | BGE-M3 进程，不配则「按意思找」不可用，按原话搜不受影响 |
| `SCOREBOOK_OCR_EXECUTABLE` | `native/ocr.swift` 编出来的可执行文件的**绝对路径**，不配则品种周期要人自己填 |
| `SCOREBOOK_RESTIC_EXECUTABLE` | `python3 ops/setup_restic.py` 装出来的那个，绝对路径 |

**交易所只读密钥和备份仓库口令永远不进这个文件。** 它们是 owner 维度的 macOS
Keychain 引用（`scorebook.exchange.{owner}…` / `scorebook.backup.{owner}…`），写
入方式是重定向 stdin，不许出现在命令行参数里：

```sh
./ops/run.sh store-secret scorebook.backup.<owner-uuid>.repository < /path/to/secret-file
```

Chat 供应商至今没有选定，别往 `.env` 里编一个 API key 和模型名——适配器明确返回
`chat_model_not_configured` 是正确行为。

## 构建、建凭证、跑起来

```sh
cd backend
cargo build --release
./ops/run.sh create-user local --token-file data/local-token
```

`create-user` 用 `O_CREAT|O_EXCL` 建 0600 的文件，已经存在就直接报错，不会覆盖你
现有的令牌。它打印出来的那个 UUID 就是 owner id，后面排作业和存 Keychain 都要用，
记下来（忘了也能查：`SELECT id FROM users WHERE name='local';`）。

手动跑两个进程：

```sh
./ops/run.sh serve     # API，127.0.0.1:8787
./ops/run.sh worker    # 队列：interactive / batch / maintenance
```

平时用 launchd 托管，一共五个服务 `api` / `worker` / `vision` / `text` /
`frontend`：

```sh
python3 ops/install-launchd.py --frontend-dir ../frontend/app
```

**注意这个 `--frontend-dir`。** `ops/install-launchd.py` 的默认值是
`../scorebook-frontend/app`，那是前后端还分在两个仓库时的布局；在这个合并仓库里
前端位于 `backend/../frontend/app`，所以必须显式传。传之前要先有
`frontend/app/dist/index.html`，脚本会断言它存在。

装好之后改代码的部署动作固定是两步：

```sh
cargo build --release
launchctl kickstart -k gui/$(id -u)/dev.scorebook.api      # 或 worker / vision / text / frontend
```

只更新其中几个服务的 plist 用 `--services api worker` 这样的参数。局域网入口是显
式的 `--lan`，省略它就退回只听 loopback；更新前端服务时要把 `--lan` 带上，否则会
被悄悄关掉。

## 认证与探活：这里最容易白费一小时

**每一个 API 调用都要带 `authorization: Bearer <token>`**，令牌就是
`backend/data/local-token` 这个文件的内容。

**探活端点是 `/v1/health` 和 `/v1/ready`，不是 `/health`。** 整个 API 只有
`/v1` 前缀这一套，`/health` 会给你 404，然后你会开始怀疑服务没起来。这两个端点是
契约里唯一免鉴权的两条（`crates/http/src/contract.rs`）。

```sh
curl -sS http://127.0.0.1:8787/v1/health
curl -sS http://127.0.0.1:8787/v1/ready

TOKEN=$(cat backend/data/local-token)
curl -sS -H "authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/capabilities
curl -sS -H "authorization: Bearer $TOKEN" 'http://127.0.0.1:8787/v1/calls?limit=1'
```

改状态的接口按契约还要 `idempotency-key` 头，以及对应的
`expected_revision` / `expected_generation`。完整契约以
`GET /openapi.json` 和 `backend/contracts/openapi.yaml` 为准。

## 前端

```sh
cd frontend/app
npm install
npm run build          # 先 tsc --noEmit 再打包到 dist/
```

页面在 <http://127.0.0.1:5178/>，两种起法只能开一个：

**一、本机部署的那一份**（没有热更新，改了代码要重新 `npm run build`）：

```sh
node backend/ops/serve-frontend.mjs \
  --dist   "$PWD/frontend/app/dist" \
  --token-file "$PWD/backend/data/local-token"
```

`--api` 默认 `http://127.0.0.1:8787`，`--port` 默认 5178，都可以改；API 那一头只
接受 loopback。launchd 托管的 `dev.scorebook.frontend` 跑的就是这条命令。

**二、开发（有热更新）**：`npm run dev`。它的 `vite.config.ts` 里令牌文件默认路径
同样还是分仓库时代的 `../../scorebook-backend/data/local-token`，在这个仓库里不存
在，所以要用环境变量指过去（写绝对路径最省事）：

```sh
SCOREBOOK_TOKEN_FILE=/absolute/path/to/scorebook/backend/data/local-token npm run dev
```

两种起法的做法是一样的：浏览器只跟本机这个服务器说话，走同源的 `/api`；令牌由
Node 进程读文件、逐请求加到 `Authorization` 头上再转发。令牌不进打包产物、不进
HTML、不进任何 `VITE_*` 变量，页面里翻不出来。不要用 `file://` 打开页面去连接口，
也不要为了图省事关掉鉴权或放开所有来源。

## 可选的本机进程

缺哪个就少哪项能力，系统照实说「没配」，不会换个算法假装成功：

| 进程 | 缺了会怎样 |
| --- | --- |
| `python3 vision/server.py`（DINOv2，8790） | 「按画面样子比」用不了，只剩按走势形状比 |
| `python3 text_encoder/server.py`（BGE-M3，8791） | 「按意思找」用不了，按原话搜不受影响 |
| `native/ocr.swift` 编出来的可执行文件 | 认图读不出品种和周期，要自己填，不会靠形状猜 |
| Restic（`ops/setup_restic.py`） | 加密备份用不了 |
| Chat 模型适配器 | 「问过去的自己」明确报 `chat_model_not_configured` |

模型权重是钉死版本的，装法见 `vision/setup.py`、`text_encoder/setup.py` 和
`backend/docs/deployment-v4.md`。

## 测试

```sh
cd backend
./ops/test.sh
```

就这一条。**不要直接 `cargo test`**：所有连库的集成测试先断言库名以
`scorebook_test` 开头（`tests/common/mod.rs`），拿着 `.env` 里的主库 URL 跑测试二
进制会当场被拒，报错只回显库名不回显 URL。这道闸是故意设的——测试会往库里写东西，
而主库里是你自己的记录。

`ops/test.sh` 载入 `.env` 之后转交 `ops/run_tests.py`，后者建一个
`scorebook_test_<hex>` 的独立库、把 `DATABASE_URL` 改指到它、跑
`cargo test --workspace -- --test-threads=1`，无论通过、失败还是中断都在 finally
里把库删掉。传给 `./ops/test.sh` 的参数会原样接到 `cargo test` 后面，但不要再自己
补第二组 `--`，脚本已经加过了。

另外三条例行检查：

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
python3 ops/check-boundaries.py
```

需要真实外部服务的测试用 `--ignored` 单独跑，跳过不算通过。

前端：`npm run check` 只做类型检查；`npm run test:integration` 对着真后端跑，要求
页面服务器和后端都开着。本机走一整套隔离环境的做法是后端的
`ops/review_frontend_local.py`，它自建库、存储目录和端口，跑完清掉——**不要拿自己
的记录当测试素材**。

## 实际怎么用

一条记录的一生是一条直线，每一步需要什么在下面写清楚了。

**一、记一条判断。** 顶栏右边那颗主按钮（⌃⇧S），在哪一页都能按。一行写完：现在
怎么看、凭什么这么看，把当时那张 K 线截图拖进去。截图的**周期必须明确选**——系统
不从图形上猜，猜错了后面所有比较都是在比不相干的东西。需要的前置只有 API 和
worker 在跑；OCR 配了的话品种和周期会预填，没配就自己选。

**二、到点复盘。** 记录到了观察期，复盘队列里会出现它。写复盘、发布。发布的同一
个事务里，系统会为这条记录每一张还没定位过的场景截图排一条 `attachment.locate`
任务，靠 `jobs` 的唯一键保证一张图自动只匹配一次。

**三、把截图钉回真实行情。** 这就是 `attachment.locate` 在做的事：拿记录自己的
品种和周期，围绕判断时刻现建一段有界索引（判断时刻往前 768 根，64/128/256 三档各
建一个世代），然后在同周期里检索。top1 分数 ≥ 0.85 且比 top2 高出 0.05 才自动写
下定位，否则只把前三个候选交给你自己挑。你用 `PUT /v1/attachments/{id}/location`
写下的定位永远保留，自动任务只插入不覆盖。这一步要能联外网取 REST 行情。

**四、重温。** 截图定位好之后，`GET /v1/calls/{id}/replay` 就能把那一段真实 K 线
放出来，从判断时刻往后走。只画真实已收盘的 K 线，未来不存在就明说。回放的 K 线临
时写在 `replay_bars` 里，退出时 `DELETE /v1/calls/{id}/replay` 立刻删掉。前置条件
只有一个：这张截图有定位。

**五、按图找（刻舟求剑）。** 上传一张截图，选周期，`POST /v1/chart-analyses` 认
图，`POST /v1/chart-search/runs` 以 `scope=binance_history` 建一次检索，在整个公
共索引里找结构相似的片段。**前置条件是那一档周期的公共索引已经建过**——这是全流程
里唯一一个「装好了也可能什么都搜不到」的地方，原因见下一节。看完候选按「都不是」，
下一轮会带着这几条的 id 作为 `exclude` 重新取数，补上没看过的三条，而不是把同一
个查询原地再跑一遍。

## 把公共历史铺开

按图找要的「广」靠 `history.universe` 作业。**它没有 HTTP 路由，openapi 里也没有
条目**，排队方式就是往 `jobs` 表插一行——这是故意押后的入口，不是漏了。

一条作业只做一个周期。粗周期先跑完，检索就能在那一档上工作；细周期是大头，什么时
候跑由人决定。

```sql
INSERT INTO jobs(id, owner_id, kind, dedupe_key, body, queue)
VALUES (gen_random_uuid(),
        (SELECT id FROM users WHERE name = 'local'),
        'history.universe',
        'universe:usd_m:4h:200:first',
        '{"market":"usd_m","interval":"4h","top":200}'::jsonb,
        'batch');
```

几件要当心的事：

- `queue` 必须是 `batch`，跟 `jobs::enqueue_tx` 对这个 kind 的归类一致，写错了会
  排进错误的队列。
- `dedupe_key` 在 `(owner_id, kind, dedupe_key)` 上唯一。同一个 key 再插一次不会
  新建作业；同一个 key 配不同的 body 会撞 `job_identity_conflict`。想重跑就换一
  个 key（上面那个 `:first` 后缀就是干这个的）。
- `market` 是 `usd_m` 或 `coin_m`，`interval` 必须是币安那 15 个之一（区分大小
  写，`1m` 是分钟、`1M` 是月），`top` 在 1..=1000。
- 作业每 45 秒把进度写一次、让出 batch 队列，几小时的活不会把队列占死。中途停最
  多丢掉正在做的那一个单元，已经做完的单元有永久标记，续跑直接跳过。
- 归档里缺一个月是常态（新币、下架、币安漏传），记进 `failures` 继续走，不算作业
  失败。

看进度：

```sh
curl -sS -H "authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/jobs/<job-id>
```

```sql
SELECT status, symbol_no, symbols_total, current_symbol,
       units_built, units_skipped, units_failed, months_downloaded, feature_rows, updated_at
FROM public_market.universe_index_runs ORDER BY started_at DESC LIMIT 5;
```

作业变成 `failed` 之后不会自己重来（比如 worker 被重启，租约丢了会以
`lease_lost` 收尾）。要么带 `idempotency-key` 头和当前 `generation` 打一次
`POST /v1/jobs/{id}/retry`，要么换个 `dedupe_key` 再插一行——已经建好的单元都有永
久标记，续跑不会重复下载。

现在库里到底有什么，自己查，别信任何文档里写死的数字：

```sql
SELECT timeframe, count(*) FROM public_market.features WHERE published GROUP BY 1 ORDER BY 2 DESC;
SELECT status, count(*) FROM history_subscriptions GROUP BY 1;   -- 滚动订阅开没开
-- 覆盖按单元算，不按行算：同一个 (symbol,start_at,end_at) 会给三档窗口各建一个世代
WITH u AS (
  SELECT DISTINCT ON (timeframe, symbol, start_at, end_at)
         timeframe, symbol, start_at, end_at, actual_start, status
  FROM public_market.coverage_segments WHERE market = 'usd_m')
SELECT timeframe, status, count(*) units, count(DISTINCT symbol) symbols
FROM u GROUP BY 1, 2 ORDER BY 1, 2;
```

拿 `coverage_segments` 的行数去数覆盖会把同一个单元数三遍，得出来的结论是错的。

## 出问题的时候

**「按图找」什么都没返回。** 先别怀疑匹配算法。绝大多数情况下是**那一档周期根本
没有索引**：15 个周期里目前只有 5 个有过东西，真正整轮扇出过的只有 1d 和正在跑的
4h。查一下 `public_market.features` 里那个 `timeframe` 有多少行，是 0 就按上一节
排一条对应周期的 `history.universe` 作业，跑完再搜。各周期行数差着一两个数量级不
是 bug，是只跑过那么多。

**`chart_interval_required`。** 截图检索必须显式给周期。这不是可以绕过去的校验：
系统不从走势形状猜、不从上一张截图继承、OCR 的提示也不算确认。前端上传截图那一步
有周期选择，直接调接口就自己在请求里带上。

**401 / 403。** 少了 `authorization: Bearer <token>`，或者令牌不是
`data/local-token` 里那一个。403 还有一种可能是 `Origin` 对不上
`SCOREBOOK_ALLOWED_ORIGIN`——它是逐字节比的，`localhost` 和 `127.0.0.1` 不是一回
事，端口也要一致。

**`/health` 404。** 是 `/v1/health` 和 `/v1/ready`。

**重温说没有定位。** 那张截图还没钉到真实行情上。`GET /v1/attachments/{id}/locate`
看一眼任务状态，`POST` 同一个地址手动触发一次；遇到已经在排队或运行中的任务它会
直接返回那一条（`deduplicated: true`），不会排第二条。

**`queue_capacity_reached`。** batch / maintenance 队列每个 owner 各 50 条在途上
限，interactive 200 条。等前面的跑完，或者查 `jobs` 看是不是有一堆卡住的。

**某项功能说「没配」。** 那是它该说的话。`GET /v1/capabilities` 把「实现了」「配
了」「验收过了」分开回答，照着上面可选进程那一节把对应的东西配上即可；它不会因为
你没配就换个算法假装成功。

**测试被拒绝。** 报错里写着 `refusing to run tests against database ...` 就是你直
接跑了 `cargo test`。用 `./ops/test.sh`。
