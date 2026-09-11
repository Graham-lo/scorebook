-- The official baseAsset separates MU from accidental matches such as ARKM + USDT.
-- Literal substring matching does not interpret user input as a LIKE pattern.
WITH matched AS MATERIALIZED (
    SELECT i.*,
        CASE
            WHEN $1 = '' OR replace(symbol, '_', '') = $1 THEN 0
            WHEN body->>'baseAsset' = $1 THEN 1
            WHEN starts_with(body->>'baseAsset', $1) THEN 2
            WHEN starts_with(replace(symbol, '_', ''), $1) THEN 3
            ELSE 4
        END AS search_rank,
        CASE WHEN $1 = '' AND COALESCE(body->>'status', body->>'contractStatus', '') <> 'TRADING' THEN 1 ELSE 0 END AS inactive_rank,
        COALESCE(array_position($6::text[], symbol), 2147483647) AS popularity_rank
    FROM instrument_catalog i
    WHERE venue = 'binance' AND market = $2
      AND ($3::text IS NULL OR body->>'underlyingType' = $3)
      AND ($1 = '' OR strpos(replace(symbol, '_', ''), $1) > 0
           OR strpos(body->>'baseAsset', $1) > 0)
)
SELECT to_jsonb(m) - 'search_rank' - 'inactive_rank' - 'popularity_rank'
FROM matched m
WHERE $4::text IS NULL OR (search_rank, inactive_rank, popularity_rank, symbol) > (
    SELECT search_rank, inactive_rank, popularity_rank, symbol FROM matched WHERE symbol = $4
)
ORDER BY search_rank, inactive_rank, popularity_rank, symbol
LIMIT $5
