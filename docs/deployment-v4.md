# v4 部署与恢复

2026-09-10：Mac 主服务已切换至 v4，主库已迁移至 schema 0041。升级前数据库和原图已备份并在隔离库实际恢复验证。原有 71 条记录、57 张附件、45 条复盘保留；之后用户新上传资料继续正常保留。VPS 部署暂停。

## Mac 本机入口

页面：http://127.0.0.1:5178/。API 127.0.0.1:8787；视觉服务 8790；文本服务 8791。PostgreSQL 17 在本机 Docker 55432。

`ops/serve-frontend.mjs` 提供构建后的前端和同源流式 API 代理，访问凭证仅在服务端读取；静态产物中没有访问令牌。默认只监听 loopback，检查 Host/Origin，并支持 SSE 和图片流。

2026-09-11 已按用户要求启用 Mac 局域网访问：`http://192.168.124.9:5178/#/home`，本机仍可用 `http://127.0.0.1:5178/#/home`。局域网设备共用 Mac 上同一账户及资料，当前没有独立访客账户；设备需与 Mac 网络互通，Mac 保持开机和唤醒。IP 来自 DHCP，变化后使用 Mac 的新地址。同日追加 Tailscale 入口：不在同一 Wi-Fi 时用 Mac 的 Tailscale 地址 `http://100.72.84.39:5178/#/home`（Tailscale 的 100.64.0.0/10 段与 RFC 1918 三段同样视为私网，其余公网来源仍拒绝）。

开启或更新局域网入口：`python3 ops/install-launchd.py --services frontend --lan`。该选项监听 IPv4，Host 仅接受 loopback 和本机当前私网网卡地址，Origin 必须与请求 Host 相同，拒绝跨站请求和非私网来源；从其它站点或聊天软件点链接进入的顶层 GET 导航（浏览器带 `Sec-Fetch-Site: cross-site`、`Sec-Fetch-Mode: navigate`）放行，只有跨站的子资源和 API 请求才被拒绝，否则 Chrome 从外部链接打开会显示 Forbidden。后端、数据库和模型端口仍只在本机使用。更新前端服务时需保留 `--lan`；省略该选项会恢复仅本机访问。

构建前端后运行 `python3 ops/install-launchd.py`，安装 api、worker、vision、text、frontend 五个当前用户 LaunchAgent。更新单个组件使用 `--services api worker` 等参数；默认前端位置是相邻的 `scorebook-frontend/app/dist`，也可通过 `--frontend-dir` 指定。不要同时保留手动启动的旧 worker。

主库测试必须使用隔离数据库。`ops/review_frontend_local.py` 建立独立库、存储、API 和代理，运行前端原始集成测试后清理。原始测试当前有未通过项，见联调报告，不要直接在主资料库运行。

## 运行组件

- Rust API / worker，共享 PostgreSQL 17 + pgvector 0.8.2。队列为 interactive / batch / maintenance，租约与代际 fencing 由 PostgreSQL 协调。
- DINOv2：`vision/requirements.lock`、`vision/setup.py`、`vision/server.py`，固定本地权重，默认 8790。
- BGE-M3：复用 `vision/requirements.lock` 环境，运行 `text_encoder/setup.py`、`text_encoder/server.py`，固定本地权重，默认 8791。CPU 两线程、编码每批最多四段。
- OCR：`native/ocr.swift` 编译为本机可执行文件，经 `SCOREBOOK_OCR_EXECUTABLE` 绝对路径指定；stdin/stdout 传输图像与识别结果。
- Restic：`python3 ops/setup_restic.py` 安装锁定版本，配置 `SCOREBOOK_RESTIC_EXECUTABLE` 为绝对路径。
- `.env.example` 只提供无凭证配置。交易所与备份密码使用 `scorebook.exchange.{owner}…` / `scorebook.backup.{owner}…` Keychain 引用。不要把真实密钥写入 Git、命令参数或聊天。
- Chat 首个供应商尚未决定；当前适配器明确报未配置。不要将脚本测试模型用于生产。

## 显式切换

1. 记录当前服务进程、数据库迁移版本和发行物 SHA；冻结业务写入及 worker。
2. 对现有数据库与所有用户原图做一致备份，在隔离位置验证可恢复；不要只备份数据库。
3. 在隔离库执行全部迁移和回归，使用独立构建目录生成 v4 发行物。确认模型、OCR、备份目标及配置状态。
4. 迁移主库至 0041。迁移 0032 取消旧结构模型任务、取消旧公共向量发布并排队原图重建；旧原始证据保留。
5. 启动唯一 v4 API/worker，运行 `POST /v1/images/index` 或检查迁移创建的任务。缺 OCR/DINO/BGE 时说明能力未配置，不退回旧算法。
6. 查看真实合约目录，先通过 `/v1/history/plans/estimate` 定义可承受范围，再建立 REST 或 monthly_archive 计划/订阅。新增合约在下一轮加入，各尺度独立续建。预算超限进入 needs_attention；暂停后 `/budget` 修改上限，再 `/control` 恢复。
7. 实际接通用户只读账户、Chat 模型和独立备份，完成真实数据核对和两小时混合验收，才可宣告上线验收完成。

不要让 v3 发行物运行在已升级数据库上，也不运行双算法降级分支。若切换失败，停止写入并恢复已验证的迁移前数据库、原图和发行物；这属于人工恢复操作，不是请求级 fallback。

## 导出与恢复

正常归档严格要求 schema 42。旧 schema 19 只能先执行：

```sh
scorebook upgrade-export /absolute/old-archive /absolute/new-upgraded-archive
scorebook verify-export /absolute/new-upgraded-archive
```

源目录不改变。离线升级保留历史原话，未曾记录的提交时反馈标为未采集；恢复会应用明确的旧模型取消与原图重建规则。

`scorebook restore /absolute/verified-archive` 只向独立空数据库恢复，恢复前必须指向新的数据库和存储根目录。恢复不导入账户/API/备份凭证；重新绑定已验证的 Keychain 引用，并创建新的本机访问密钥。`recover-backup` 从已配置的 Restic 仓库恢复指定快照并进行逻辑校验，再走空库恢复。

备份成功意味着已上传、读回并核对逻辑资料和原图。独立物理设备未确认时只能算本机副本；RPO/RTO 必须通过实际目的地演练衡量。

## 可重复验证

`ops/test.sh` 每次自动创建独立临时数据库，测试结束（包括失败或中断）后立即删除，不使用主资料库或保留共享测试库。所有连库的集成测试（`tests/common/mod.rs::test_db_url`）会先断言库名以 `scorebook_test` 开头，直接用 `.env` 里的主库 URL 跑测试二进制会立刻拒绝，失败信息只回显库名不回显 URL。需要本机 `psql` 客户端，或本仓库默认的本机 PostgreSQL Compose 服务；只保留测试日志。

```sh
ops/test.sh --workspace
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
python3 ops/check-boundaries.py
```

需要实际外部/本机服务的测试使用 `--ignored` 单独运行；`ops/test.sh` 已自动附加测试参数，不要再传第二组 `--`。真实 Restic、BGE、月档、逐日档、B1 与 WebSocket 测试逐项报告，不把跳过视为通过。数据库脚本必须使用隔离库；所有 `*_v3.py` 仅对应 v3 checkout，v4 大库实验使用 `ops/ann_acceptance_v4.py`。
