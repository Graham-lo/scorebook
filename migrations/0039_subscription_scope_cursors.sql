-- One continuation per actual contract / interval / scale. Global cycle time is informational.
CREATE TABLE history_subscription_cursors(
 owner_id uuid NOT NULL,subscription_id uuid NOT NULL,symbol text NOT NULL,timeframe text NOT NULL,
 window_bars int NOT NULL CHECK(window_bars IN(64,128,256)),next_start timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,subscription_id,symbol,timeframe,window_bars),
 FOREIGN KEY(owner_id,subscription_id) REFERENCES history_subscriptions(owner_id,id) ON DELETE CASCADE
);
-- Explicitly derive cursors from successful ranges of completed plans. No legacy cursor reader.
INSERT INTO history_subscription_cursors(owner_id,subscription_id,symbol,timeframe,window_bars,next_start)
SELECT sp.owner_id,sp.subscription_id,i.body->>'symbol',i.body->>'interval',(i.body->>'window_bars')::int,
 max((i.body->>'end_at')::timestamptz-((i.body->>'window_bars')::int-(i.body->>'stride_bars')::int)*
 CASE i.body->>'interval' WHEN '1m' THEN interval '1 minute' WHEN '5m' THEN interval '5 minutes' WHEN '15m' THEN interval '15 minutes' WHEN '1h' THEN interval '1 hour' WHEN '4h' THEN interval '4 hours' WHEN '1d' THEN interval '1 day' END)
FROM history_subscription_plans sp JOIN history_plans p ON p.id=sp.plan_id AND p.status='completed'
JOIN jobs j ON j.owner_id=sp.owner_id AND j.dedupe_key LIKE sp.plan_id::text||':%' AND j.kind='history.index' AND j.status='succeeded'
JOIN history_indexes i ON i.id=j.id WHERE (i.coverage->>'source_range_complete')::boolean IS TRUE
GROUP BY sp.owner_id,sp.subscription_id,i.body->>'symbol',i.body->>'interval',(i.body->>'window_bars')::int;
