WITH reps AS(SELECT *,row_number() OVER(PARTITION BY signature ORDER BY submitted_at DESC,call_id DESC,claim_no DESC) AS recent FROM set_sample_members WHERE owner_id=$1 AND run_id=$2 AND representative AND selected AND state IN ('realized','unrealized')),
metrics AS(SELECT signature,count(*) AS n,count(*) FILTER(WHERE state='realized') AS wins,count(*) FILTER(WHERE recent<=10) AS recent_n,count(*) FILTER(WHERE recent<=10 AND state='realized') AS recent_wins FROM reps GROUP BY signature),
observations AS(SELECT signature,key,value::numeric AS v,row_number() OVER(PARTITION BY signature,key ORDER BY value::numeric) AS rank,count(*) OVER(PARTITION BY signature,key) AS total FROM set_sample_members m CROSS JOIN LATERAL(VALUES('mfe',m.body->'result'->>'mfe'),('mae',m.body->'result'->>'mae')) x(key,value) WHERE m.owner_id=$1 AND m.run_id=$2 AND representative AND selected AND value IS NOT NULL),
medians AS(SELECT signature,key,avg(v)::text AS median FROM observations WHERE rank IN ((total+1)/2,(total+2)/2) GROUP BY signature,key),
events AS(SELECT signature,date_trunc('day',(body->'result'->>'trigger_at')::timestamptz) AS at,count(*) AS n FROM set_sample_members WHERE owner_id=$1 AND run_id=$2 AND representative AND selected AND body->'result'->>'trigger_at' IS NOT NULL GROUP BY signature,at),
groups AS(SELECT signature,count(*) AS representatives FROM set_sample_members WHERE owner_id=$1 AND run_id=$2 AND representative AND selected GROUP BY signature)
SELECT jsonb_build_object('signature',g.signature,'representative_count',g.representatives,'numerator',COALESCE(m.wins,0),'denominator',COALESCE(m.n,0),'realization_rate',CASE WHEN m.n>0 THEN (m.wins::numeric/m.n)::text ELSE NULL END,
'mfe_median',(SELECT median FROM medians WHERE signature=g.signature AND key='mfe'),'mae_median',(SELECT median FROM medians WHERE signature=g.signature AND key='mae'),
'recent_explicit_count',COALESCE(m.recent_n,0),'recent_rate',CASE WHEN m.recent_n>0 THEN (m.recent_wins::numeric/m.recent_n)::text ELSE NULL END,
'recheck',COALESCE(m.recent_n=10 AND m.wins::numeric/m.n-m.recent_wins::numeric/10>=0.20,false),
'trigger_day_distribution',COALESCE((SELECT jsonb_agg(jsonb_build_object('day',e.at,'count',e.n) ORDER BY e.at) FROM events e WHERE e.signature=g.signature),'[]'))
FROM groups g LEFT JOIN metrics m ON m.signature=g.signature ORDER BY g.signature
