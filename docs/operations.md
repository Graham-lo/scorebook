# 本机运行和恢复

不把本机开发环境当作公网多用户产品。三个进程分别启动 API、worker、视觉模型；PostgreSQL 由 compose 管理。

## 启动与升级

`cargo build --release`、`ops/run.sh migrate`，然后运行 API/worker；视觉模型按 README 准备。macOS 可运行 `python3 ops/install-launchd.py`，安装当前仓库的 dev.scorebook.api/worker/vision 用户级服务。配置只引用本机路径，不包含凭证；日志在 data/logs。先停止已核实属于本项目的手动进程，避免占用相同端口。

LaunchAgents 在该用户登录后运行，要求 Docker Desktop 已启动。PostgreSQL 容器使用 restart:unless-stopped；compose 设置 1 GB 共享内存，避免大型并行索引构建受 Docker 默认 /dev/shm 限制。修改该配置只有重建容器后生效，重建前应停止 API/worker并备份；已有数据卷保留。

API 存活 `/v1/health` 不依赖 DB；就绪 `/v1/ready` 用有限时缓存探测。接口超载返回 server_busy，调用者按明确重试指令处理，不隐藏错误。DB 每进程池 12、worker 2/1/1 类别预算、图像编码 2、Python 推理 1。数据库共享 ANN 搜索最多 8 路，满载返回 search_capacity_reached；每路扫描内存预算约 128MB，另有执行与进程开销。公网登录/对象存储/数据库角色加固需单独部署方案。

## 数据保护

升级前停止旧 worker/API，`ops/backup.sh /absolute/protected.dump` 生成数据库备份。原图需要同时复制 data/attachments 或生成并下载完整 v2 逻辑导出。备份和明文凭证不进入 Git。不要备份系统重绘 K 线/图表，它们本来就不持久化。

v2 归档包含 manifest.json、manifest.sha256、NDJSON chunks 和原图附件。`verify-export` 验证全体文件；不支持用宽松校验读取旧格式。旧 v1 归档需要另做显式离线转换，不在生产请求中自动兼容。

恢复必须指定隔离数据库和独立存储目录，用新的环境调用 `scorebook restore /absolute/archive`。先校验并准备原图，再用 COPY 和一个元数据事务发布。中断后重新运行同一命令：相同归档的身份标记/恢复回执允许继续，已有其他用户资料则明确拒绝覆盖。数据库和文件仍是两个存储系统；恢复中的暂存目录只在本机使用，若主动放弃恢复，应在确认没有 restore 进程后手工清理对应 restore_staging 目录，不能把它当成完成的备份。

## 日常处理

任务处理故障由相同新版实现按退避重试；明确能力缺失和缺输入不反复请求供应商。人工重试必须携带当前 generation，不能用重复提交重置失败任务。历史计划暂停后保持进度，恢复会使旧执行者失去发布资格。

搜索快照、查询图、导出和尝试记录有 TTL；已保存搜索和仍被记录引用的原图保留。物理清理使用精确 ID 的维护任务。云端或外部已经下载的归档无法撤回。

日志只输出操作/错误码，不记录正文、图片、行情或查询文本。生产运维应另配日志轮转、容量告警和数据库监控，不把这些字段放入交易员界面。当前并未交付 Prometheus 仪表盘或完整 SLO 告警系统。

## 验证

`ops/test.sh --features vision-tests` 用隔离测试库验证真实 PostgreSQL 和本地模型。CI 默认不下载模型，显式模型测试在具备本地权重的环境运行。

`ops/acceptance_v3.py` 创建并删除唯一命名的合成测试库，30 分钟混合读取/草稿保存、百万行流式导出、进程中断/重启。`ops/ann_acceptance_v3.py` 同样隔离，创建百万合成特征并对实际 SQL 做 EXPLAIN 和精确对照。脚本需要 psycopg、numpy；不会使用主知识库做容量填充。合成基准不能替代真实截图语义标注或正式生产候选环境验收。
