-- 周期扩容：public_market.features 补齐币安合约 klines 的其余 9 个周期子分区。
--
-- 0022 只建了 1m/5m/15m/1h/4h/1d 六个 timeframe 子分区，写入其它周期会直接
-- 报 "no partition of relation ... found for row"。这里按 market 各补 9 个：
-- 3m 30m 2h 6h 8h 12h 3d 1w 1M，补完每个 market 下 15 个周期齐全。
-- 0022 本身不改动（已经跑过的迁移不回头改）。
--
-- 命名沿用 features_<market>_<tf>，只有月线例外：PostgreSQL 的未加引号标识符会
-- 折叠成小写，'1M'（月）会和 '1m'（分钟）撞成同一个表名 features_usd_m_1m。
-- 用 format('%I') 加引号保留大小写只是把问题藏进引号里——之后任何不加引号的
-- 引用都会解析错——所以月线的**表名**改用归档目录同款写法 1mo：
--   features_usd_m_1mo / features_coin_m_1mo。
-- 表名只是物理名字，分区键的值仍然是币安原文 '1M'（FOR VALUES IN ('1M')），
-- 对外 API 与 timeframe 列里存的也依旧是 '1M'。
DO $$ DECLARE m text; tf text; parent text; child text; BEGIN
 FOREACH m IN ARRAY ARRAY['usd_m','coin_m'] LOOP
  parent:='features_'||m;
  FOREACH tf IN ARRAY ARRAY['3m','30m','2h','6h','8h','12h','3d','1w','1M'] LOOP
   -- 月线表名用 1mo，避开 '1M' 与 '1m' 折叠后的同名冲突。
   child:=parent||'_'||CASE tf WHEN '1M' THEN '1mo' ELSE tf END;
   EXECUTE format('CREATE TABLE public_market.%I PARTITION OF public_market.%I FOR VALUES IN (%L)',child,parent,tf);
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public_market FROM PUBLIC;
