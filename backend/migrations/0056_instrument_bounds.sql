CREATE TABLE public_market.instrument_bounds(
 market text NOT NULL CHECK(market IN ('usd_m','coin_m')),
 symbol text NOT NULL,
 interval text NOT NULL,
 first_bar_at timestamptz,
 last_bar_at timestamptz,
 gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
 verified_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(market,symbol,interval)
);

-- Merge inside ON CONFLICT's row lock: concurrent observations cannot lose gaps.
-- The running maximum also handles nested intervals; touching gaps coalesce.
CREATE FUNCTION public_market.merge_instrument_gaps(observations jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH spans AS (
   SELECT "start", "end", seen_at,
     max("end") OVER (ORDER BY "start", "end" ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_end
   FROM jsonb_to_recordset(observations) AS g("start" timestamptz, "end" timestamptz, seen_at timestamptz)
 ), islands AS (
   SELECT *, sum(CASE WHEN previous_end IS NULL OR "start" > previous_end THEN 1 ELSE 0 END)
     OVER (ORDER BY "start", "end") AS group_id FROM spans
 ), merged AS (
   SELECT min("start") AS "start", max("end") AS "end", max(seen_at) AS seen_at
   FROM islands GROUP BY group_id
 )
 SELECT COALESCE(jsonb_agg(to_jsonb(merged) ORDER BY "start"), '[]'::jsonb) FROM merged;
$$;
