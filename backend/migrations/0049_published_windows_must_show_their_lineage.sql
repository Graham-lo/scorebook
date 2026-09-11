-- 公布了却说不出来路的窗口：能证明的挂回去，证不出来的撤下来。
--
-- `public_market.features` 里一行 `published=true`，说的是「这一段行情可以当证据端
-- 给人看」。它凭什么端得出去，全靠 `generation_features` 里那一行链接指向某个
-- `status='ready'` 的世代——检索时 `attach_market_sources` 就是顺着这条链接去问「这段
-- K 线是 REST 拉的还是月档解出来的」。链接没了，这一行就成了没有出处的证据。
--
-- 1d 扇出补跑那天断了 2470 条链接，涉及 19 个品种。断法是这样的：一个 `ready` 但源
-- 范围不完整的世代还允许被重新抢占补跑；补跑拉到的第一根 K 线换了位置，窗口网格整体
-- 错位，上一趟已经公布过的那一批窗口全都不在新的 `retained` 名单里，`publish_index`
-- 于是删掉了它们的链接——却没有把 `published` 一起撤掉。行还在，还挂着「可以端出去」，
-- 唯一能证明它来路的那一行却没了。代码那一侧这一趟已经补上（撤链接的同时撤公布），
-- 这个迁移收拾已经躺在库里的那一批。
--
-- 不变量只有一句：**一行 published 的特征，必须有至少一个 ready 世代认领它。**
-- 按这句话收拾，只有两种下场，都按证据说话：
--
-- 一、证得出来的，把链接挂回去。同 market/symbol/timeframe、同 window_bars、模型名单
--     里有这一行用的模型、请求范围完整包住这个窗口、来源是 `rest` 或 `monthly_archive`
--     的 ready 世代——五条同时满足，这一行本来就只可能是那个世代产出的，链接是丢了，
--     不是从来没有过；补上它是还原事实，不是替它编一个出处。少一条都不补。
--     合格的世代不止一个时取最近公布的那一个（`published_at` 降序，同一时刻取 id 最小
--     的那一个）：同一段范围重建过几次，最新公布的那一次才是系统现在对外说的话；id 是
--     兜底的定序键，让这个迁移在任何一份副本上跑出来的结果都一样。
--
-- 二、证不出来的，撤下来（`published=false`）。行不删——向量和时间坐标本身没有错，
--     `maintenance.gc` 有它自己处理无人认领的未公布行的规矩；撤掉的只是「这可以当证据
--     端出去」这句话。给一段数据安一个它自己证明不了的出处，比少给一条检索结果坏得多。
--
-- 两条语句都是幂等的：再跑一遍，孤儿已经不在了，一行都不会变。

INSERT INTO public_market.generation_features(generation_id,feature_id)
SELECT DISTINCT ON (f.id) g.id,f.id
FROM public_market.features f
JOIN public_market.generations g
  ON g.status='ready'
 AND g.body->>'market'=f.market
 AND g.body->>'symbol'=f.symbol
 AND g.body->>'interval'=f.timeframe
 AND g.body->>'source' IN ('rest','monthly_archive')
 AND (g.body->>'window_bars')::int=f.bars_count
 AND g.body->'models' @> to_jsonb(f.model_id)
 AND (g.body->>'start_at')::timestamptz<=f.start_at
 AND (g.body->>'end_at')::timestamptz>=f.end_at
WHERE f.published
  AND NOT EXISTS(SELECT 1 FROM public_market.generation_features l WHERE l.feature_id=f.id)
ORDER BY f.id,g.published_at DESC NULLS LAST,g.id
ON CONFLICT DO NOTHING;

UPDATE public_market.features f SET published=false
WHERE f.published
  AND NOT EXISTS(SELECT 1 FROM public_market.generation_features l WHERE l.feature_id=f.id);
