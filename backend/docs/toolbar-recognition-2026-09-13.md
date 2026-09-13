# 周期选中状态与可选指标识别（后端）

用户最新分工：Codex 只改后端；前端由 Claude 修改。本轮没有修改、构建或重启前端。

## 接口契约

`POST /v1/chart-analyses` 的现有 `recognized` 新增可选 `indicators` 数组。请求结构不变。例如：

```json
{
  "recognized": {
    "symbol": "SNDKUSDT",
    "interval": "1h",
    "anchors": {"interval_from": "toolbar_relative_contrast"},
    "indicators": [
      {"name":"MA","parameters":[30,120,256],"source":"visible_text","parameter_source":"user_default"},
      {"name":"EMA","parameters":[12,144,169],"source":"visible_text","parameter_source":"user_default"}
    ]
  }
}
```

上述 MA/EMA 仅在读到对应指标图例时出现，并非默认同时开启。参数是用户指定默认值，不宣称从图片上读出了这些数字。其他可读图例（MACD、MAVOL、VOL、BOLL、RSI、KDJ、持仓量）尽力返回；文字不可靠则省略。空数组是正常结果，不阻塞匹配/定位。前端可自行消费该字段，本轮不包含指标绘制。

周期保留原有 canonical 值（例如 `1h`）。同一行至少三个周期标签时，比较字色、与背景的对比、按钮底色和下划线；不固定蓝色/黄色。仅明显且唯一的高置信标签自动填入；没有明显区别或多个冲突选中项时保持未知。单一明确文字周期仍兼容，低置信其他周期会阻止错误的单项回退。

## 实现与升级

- `native/ocr.swift` 保留原英文优先 OCR，补充中文优先周期 token 识别（顶部 40%），按实际文本边界取框。补充识别失败不丢弃主识别结果。
- `chart_search/toolbar.rs` 实现中英文周期规范化、相对样式判定、指标名称与默认参数。
- `chart_search/analysis.rs` 统一供 analyze/定位使用，并给选中样式保留来源。
- OCR 缓存协议升级为 `native-ocr-toolbar-v2`，分析内容版本为 `toolbar-contrast-indicators-v4`。旧缓存证据保留，新请求使用新规则；相同幂等键仍返回原响应。
- 迁移 `0055_toolbar_recognition.sql` 给 `attachment_reads` 添加 `recognition_version`；定位请求刷新旧版本派生文字缓存。已保存人工/自动定位不改写，状态 GET 不启动 OCR。
- 无新增环境变量。更新本机 OCR 可执行文件，release build，然后重启 api/worker 即可；无需补索引或重新校准。只涉及截图元数据，不新增持久化原始行情。

## 验证

- 真实用户 SNDK 截图读到高亮 `1时` → `1h`；MA 默认 `[30,120,256]`，并读到 MACD / MAVOL / VOL。
- 单测覆盖浅色、深色、字色、亮度、底色、下划线、无高亮、多高亮、低置信和两次 OCR 标签重复，以及 MA/EMA 参数和未知指标。
- 私人截图不提交测试仓库。可显式设置 `SCOREBOOK_TOOLBAR_IMAGE` 和 `SCOREBOOK_TOOLBAR_OCR` 运行 ignored 测试 `supplied_screenshot_has_selected_hour_and_ma_defaults`。
- 其他 AICoin/币安版本属于基于相同规则的兼容目标，不声称已经对所有 UI 版本做过实图验证。

完整隔离库回归：226 通过、0 失败、11 忽略（包含本次可选实图用例）；最终源码的周期/指标单测与显式实图验证另跑 5 项全部通过，clippy 全工作区/全 targets 零警告。隔离测试库已删除。

本机部署完成：已更新 OCR 二进制、重启 api/worker，迁移 0055 生效，健康接口 200。实际 `POST /v1/chart-analyses` 分析 `963bd227-74fa-444b-a447-fae51f73ae4f` 返回 SNDKUSDT、`1h`、`toolbar_relative_contrast`、MA 默认参数及 MACD/MAVOL/VOL，断言全部通过。前端服务未重启。
