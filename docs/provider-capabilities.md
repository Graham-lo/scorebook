# 币安数据能力与验证边界

当前政策：所有新记录以币安合约为行情参考，默认 USDⓈ-M，COIN-M 可显式选择。spot 运行适配已移除，不保留兼容或自动退回路径。

2026-09-09 在本机真实请求 exchangeInfo：USDⓈ-M 返回 897 个 symbol，COIN-M 返回 30 个 symbol。清单含交易中、非交易中及不同合约类型，不等于全部当前可交易品种数量。

观察到的 underlyingType 包括 COIN、EQUITY、COMMODITY、INDEX、CN_EQUITY、HK_EQUITY、KR_EQUITY、PREMARKET。TSLAUSDT、NVDAUSDT、AAPLUSDT、MSFTUSDT、SPYUSDT 等返回 TRADIFI_PERPETUAL/EQUITY；XAUUSDT/XAGUSDT 为 COMMODITY。SPXUSDT 在本次响应中为 COIN/Meme，不能当作标普指数。

公共接口：

- USDⓈ-M：`/fapi/v1/exchangeInfo`、`/fapi/v1/klines`、`/fapi/v1/aggTrades`。
- COIN-M：对应 `/dapi/v1/` 路径。
- K 线支持 1m/5m/15m/1h/4h/1d；接口值保留十进制文本。
- 当前读取成交价格。标记价、指数价尚未作为独立可选数据源交付。
- K 线按请求端点裁掉跨界/未完成 bar，分别标明；缺口不补造。
- 自动评价以小范围 aggregate-trade 请求证明端点和边界片段，完整分钟来自 K 线。仍需覆盖各种合约和缺口情况的真实验收，不能把一次成功请求等同于全历史覆盖证明。

历史可取得范围受合约上市、退市、接口限制和供应商保留政策影响。没有“任何 ticker 的所有历史都一定可取”的承诺。历史索引每次发布实际范围、源 bar 数和缺口统计。

来源：[币安合约接口文档](https://developers.binance.com/en/docs/catalog)、[币安 TSLA 永续合约说明](https://academy.binance.com/ur-PK/articles/how-to-trade-tesla-tsla-on-binance-futures)、本次真实 exchangeInfo 请求。源行情仅在内存验证，不保存原始行情响应。
