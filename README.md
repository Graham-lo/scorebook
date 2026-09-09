# Scorebook Backend

交易判断、截图与复盘知识库的模块化 Rust 后端。当前为 **0.1.0 基础实现**，不是原任务书全部 P1/P2/P3 已验收的声明。前端不在本项目中修改。

- Rust / Axum / Tokio / SQLx；PostgreSQL 17 + pgvector。
- 用户数据隔离，Bearer 密钥哈希存储；单独的模型只读密钥。
- 不可变原话、图片附件、追加复盘/更正事件、幂等写入及修订冲突。
- 中文子串与标签别名找回；情境关联、打法版本、固定集合与样本身份。
- 默认 **币安 USDⓈ-M 合约**；美股相关合约、加密、商品等共用数据适配器。COIN-M 可显式指定。
- **K 线、逐笔行情、系统绘图不持久化**。REST 请求后在内存中解析、计算、重绘。保留用户上传图片、原话、复盘、特征向量及窗口位置。
- 图片复盘库搜索：结构描述子、独立本地 DINOv2、两者排名融合。
- 币安历史窗口搜索：有界后台索引 → 只存向量与时间位置 → 截图搜索 → 按命中区间重新取行情绘图。
- 大模型工具层与具体厂商无关；暂不实现 Chat 生成或自动理解用户意图。

## 启动

已创建的本机 `.env` 含独立数据库凭证，文件权限 0600，不在 Git 中。新环境复制 `.env.example` 并生成新密码。

```sh
docker compose up -d postgres
cargo build --release
ops/run.sh migrate
ops/run.sh refresh-instruments
mkdir -p data
ops/run.sh create-user local --token-file data/local-token
ops/run.sh serve
# 第二个终端
ops/run.sh worker
```

API 默认 `127.0.0.1:8787`，数据库默认 `127.0.0.1:55432`。关闭终端会结束相应前台进程；尚未安装 launchd 自启动。不要把本地开发部署当作公网多用户生产部署。

本地视觉模型可独立关闭，结构检索和记录链路仍可用：

```sh
python3 -m venv vision/.venv
vision/.venv/bin/pip install -r vision/requirements.lock
vision/.venv/bin/python vision/setup.py
vision/.venv/bin/python vision/server.py
```

模型运行时只加载本地文件；setup 下载固定 revision 的权重。`.env` 配置 `SCOREBOOK_VISION_URL=http://127.0.0.1:8790` 后，图片后台任务同时提取视觉特征。模型源、权重 SHA-256、预处理固定在 `vision/server.py` 和 Rust 适配器中。

## 接口入口

`GET /openapi.json`；静态契约见 [contracts/openapi.yaml](contracts/openapi.yaml)。所有业务接口需 `Authorization: Bearer <token>`。持久化写入需 `Idempotency-Key`；追加复盘、作废、补图等还需 `expected_revision`。

| 动作 | 接口 |
|---|---|
| 记录、找回、详情 | `POST/GET /v1/calls`、`GET /v1/calls/{id}` |
| 上传用户图片、下载原图 | `POST /v1/attachments`、`GET /v1/attachments/{id}` |
| 复盘、标签、打法、行情段 | `/v1/reviews`、`/v1/tags`、`/v1/playbooks`、`/v1/episodes` |
| 复盘库按图搜索 | `POST /v1/similarity/search` |
| 历史行情特征建库、覆盖 | `POST/GET /v1/history/indexes` |
| 从币安历史窗口按图搜索 | `POST /v1/history/search` |
| 临时行情、临时 SVG 图 | `POST /v1/market/data`、`POST /v1/market/chart` |
| 模型工具发现与调用 | `GET /v1/knowledge/tools`、`POST /v1/knowledge/tools/call` |
| 任务、事件、导出、删除 | `/v1/jobs/{id}`、`/v1/events`、`/v1/exports`、`/v1/deletions` |

HTTP 示例使用占位密钥，不应把真实密钥复制进 Git。参见 [docs/api-workflows.md](docs/api-workflows.md)。

## 代码边界

| 目录 | 唯一职责 |
|---|---|
| `src/domain/` | 纯函数：显式语法、Decimal 评价、日历、样本统计、绘图 |
| `src/application/` | 按功能拆分的用例；记录、复盘、历史索引、检索、结算、导出、删除、模型工具 |
| `src/adapters/` | PostgreSQL、文件存储、币安 REST、本地图像特征服务 |
| `src/http/` | 按用例分组的 HTTP 适配、认证、契约，不复制业务规则 |
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
cargo fmt -- --check
cargo clippy --all-targets --features vision-tests -- -D warnings
```

集成测试必须使用专用数据库，不会静默跳过数据库测试。当前实现、实测结果与仍未完成的验收见 [docs/status.md](docs/status.md)。
