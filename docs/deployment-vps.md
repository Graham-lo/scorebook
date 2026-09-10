# Scorebook：107 VPS 部署

目标：`orderflow-vps`（107.174.172.10），独立目录 `/opt/scorebook`。面向单人使用，通过 SSH 隧道访问，个人资料不从 Mac 迁移。

## 构建与运行

- Debian 12 / x86_64；Rust release、thin LTO；Cargo.lock 锁定依赖。
- Python 3.11 使用 `vision/requirements-linux.lock`，固定 CPU Torch 与 NumPy 版本；DINOv2 / BGE-M3 使用原有锁定权重与 SHA-256 校验。
- Linux OCR 明确使用 Tesseract 5 英文识别，`native/ocr_linux.py` 接受有界 stdin；报告 `tesseract-5-eng-v1`，不伪装为 Apple Vision，不在两个识别器间自动回退。周期仍由用户明确选择。
- `ops/install-vps.py` 建立专属系统用户、独立 pgvector PostgreSQL 17 容器和数据卷、API / worker / vision / text / frontend 五个 systemd 服务。
- PostgreSQL 只绑定 `127.0.0.1:55433`，API 8787、视觉编码 8790、文本编码 8791、前端 5179 都只绑定回环地址。凭证只在 VPS 的受限文件中。
- 前端 BFF 注入后端凭证；目前没有公网登录入口，不应直接通过公网反向代理发布这个 BFF。
- 后台不开历史订阅；准备历史由用户主动发起。特征索引与定位信息存 PostgreSQL，原始行情和系统重绘图不持久化。

## 访问

Mac 运行：

```sh
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:5179:127.0.0.1:5179 orderflow-vps
```

然后打开 `http://127.0.0.1:5179`。这里显示的是 VPS 资料库；5178 仍是 Mac 本地实例。

## 验收

`ops/verify_vps.py` 使用一次性数据库和目录。明确从 Binance 官方月度归档读取 BTC / ETH 的 2026-08 月 4h 数据，验证完整覆盖、OCR、DINOv2、BGE-M3、周期必选、几何索引、同周期匹配及 SVG 重绘。不下载全部市场；测试结束在 finally 中停止测试进程并删除临时库、截图及特征。回执只保存元数据和通过/失败结论。

## 已知运行条件

107 VPS 直连 Binance Futures REST 返回 HTTP 451。实时行情、24h 成交量排行、合约目录刷新及依赖 REST 的历史/结果核验因此受限；错误如实返回，不自动改用其他交易所、代理或归档。官方月度归档是用户明确选择的独立来源，不能据此宣称实时 REST 恢复。

没有配置对话生成模型、交易所账户密钥和远程备份；Linux 的这些能力不能借用 Mac Keychain。真实用户截图的盲测匹配质量也尚未验收。

## 清理边界

此次仅清理明确属于订单流的数据库表、订单流 outbox / audit 行、已停用容器、NATS 专属卷和 `/opt/bit-orderflow*` 指定旧目录。实盘监控与其共享 PostgreSQL 数据卷保留；`/opt/live-position-monitor` 保存独立启动配置。旧实盘通知 outbox 保持原来的停用状态。FOMO / Telegram 及其他项目不改动。未创建备份。
