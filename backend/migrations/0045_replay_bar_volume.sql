-- 重温缓存补上成交量：VOL 副图需要它，判决从不读它。
-- 旧行留 null，过期清扫（24h）会自然把它们换成带量的新行。
ALTER TABLE replay_bars ADD COLUMN volume text;
