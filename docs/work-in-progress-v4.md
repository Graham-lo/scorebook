# v4 实施检查点

2026-09-10，分支 codex/backend-personal-v4。主服务仍为 v3、主库 schema 19，未部署。

六模块实现与详细验收状态以 [status.md](status.md) 为准；接口见 contracts/openapi.yaml，对接见 claude-frontend-handoff-v4.md，切换/恢复见 deployment-v4.md。

当前隔离数据库已验证至 0041。全工作区非外部测试 85 项通过。百万向量 ANN、五万成交分批投影、真实月档/逐日档/B1、本地 OCR/BGE、Restic 与 v19 显式恢复分别有证据；不代表真实用户质量或两小时混合验收通过。

外部条件仍待用户：首个 Chat 供应商与凭证授权、真实账户读取凭证/账单、独立备份目的地、200 张图和 60 个问题的验收集。WebSocket 实际网络握手尚未通过。P6、前端、多用户不做。
