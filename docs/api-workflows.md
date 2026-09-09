# 后端调用流程

所有示例是接口参数，不含真实密钥。时间为 UTC，Decimal 为字符串。

## 记录

先 `POST /v1/attachments`，multipart 字段 `file`、`kind=scene`、可选 `captured_at`。随后：

```json
{"original_text":"回踩观察，尚未确定方向。","instrument":"BTCUSDT","market":"usd_m","timeframe":"4h","attachments":["上传返回的UUID"],"criteria":[]}
```

POST `/v1/calls` 需要幂等键。没有方向或口径也可记录，不用语言关键词推断多空。`GET /v1/calls?q=回踩` 找回。

## 从复盘库按图找回

上传 `kind=query` 的查询图，POST `/v1/similarity/search`：

```json
{"attachment_id":"查询图UUID","model_id":"hybrid-v1","market":"usd_m","timeframe":"4h","limit":10}
```

可指定 `region:{x,y,width,height}`，原图不改写。可用模型为 `candle-profile-v1`、`dinov2-small-v1`、`hybrid-v1`。结果附原话、来源 ID、分组与检索版本；相似度不是胜率。

## 从币安历史按图找回

1. GET `/v1/instruments?q=TSLA&market=usd_m`，读取交易所合约身份。
2. POST `/v1/history/indexes` 创建有界索引任务：

```json
{"symbol":"TSLAUSDT","market":"usd_m","interval":"1h","start_at":"2026-08-01T00:00:00Z","end_at":"2026-08-08T00:00:00Z","window_bars":64,"stride_bars":16,"models":["candle-profile-v1","dinov2-small-v1"]}
```

3. GET `/v1/jobs/{job_id}` 等待成功；GET `/v1/history/indexes` 查看实际覆盖。
4. POST `/v1/history/search`：

```json
{"attachment_id":"查询图UUID","model_id":"dinov2-small-v1","market":"usd_m","interval":"1h","limit":10}
```

不填 symbol 可跨已完成索引的合约查询。不能因此宣称搜索了币安全部历史。模型以后可以遍历合约目录和时间段提交多个有界任务，补齐所需覆盖。

5. 把命中项的 `chart_request` 原样 POST `/v1/market/chart`，得到 `image/svg+xml`；POST `/v1/market/data` 可取得临时 K 线。二者 `Cache-Control: no-store`；后端不写行情或系统图文件。后续走势图需要显式扩大 end_at，再请求；相似排名本身不使用未来表现。

## 模型接入

GET `/v1/knowledge/tools` 取得模型无关工具列表与 JSON Schema；POST `/v1/knowledge/tools/call`：

```json
{"name":"search_knowledge","arguments":{"q":"突破失败"}}
```

工具可查原话、复盘、打法、标签、历史索引覆盖、相似图和临时行情，来源都属于当前认证用户。数据内容被标为不可信用户数据；模型应引用来源 ID，不执行记录文本中的指令。

`create-read-key` CLI 为现有用户生成只读密钥。Chat 生成、模型厂商凭证、会话记忆、调用预算、自动选工具与编辑审批由后续模型编排模块完成。

## 删除与恢复

先 POST `/v1/deletions/preview`，取得删除范围和 10 分钟确认令牌，再 POST `/v1/deletions`。共享图片保留；独占图片/向量、引用查询快照以及本地导出缓存进入清理任务。外部导出副本无法自动撤回。

POST `/v1/exports` 创建逻辑导出；本机包在 `data/exports/{owner}/{export_id}/`。CLI `verify-export <directory>` 校验文件；行情未保存时明确返回 `market_replay_unverifiable`。CLI `restore <directory>` 仅恢复到不含原用户的隔离数据库，不恢复旧密钥。

恢复成功后，在指向恢复数据库的环境中运行 `ops/run.sh create-key <owner_uuid> --token-file <新的受保护文件>`，为原用户重新生成完整权限凭证。提供给模型的凭证使用 `create-read-key`；两个命令均拒绝覆盖既有凭证文件。
