WITH src AS (
 SELECT c.id,c.submitted_at,c.body,c.instrument,c.market,c.timeframe,st.voided,ep.episode_id,ep.status AS group_status,
 EXISTS(SELECT 1 FROM adoptions a JOIN playbooks p ON p.owner_id=a.owner_id AND p.id=a.playbook_id
 WHERE a.owner_id=c.owner_id AND a.call_id=c.id AND (p.body->'evidence_call_ids' ? c.id::text OR c.submitted_at<=p.created_at)) AS formation_case
 FROM calls c JOIN call_state st ON st.owner_id=c.owner_id AND st.call_id=c.id
 LEFT JOIN LATERAL(SELECT episode_id,status FROM episode_links WHERE owner_id=c.owner_id AND call_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) ep ON true
 WHERE c.owner_id=$1
 AND ($3->>'start_at' IS NULL OR c.submitted_at>=($3->>'start_at')::timestamptz)
 AND ($3->>'end_at' IS NULL OR c.submitted_at<($3->>'end_at')::timestamptz)
 AND ($3->>'instrument' IS NULL OR c.instrument=$3->>'instrument')
 AND ($3->>'market' IS NULL OR c.market=$3->>'market')
 AND ($3->>'timeframe' IS NULL OR c.timeframe=$3->>'timeframe')
 AND ($3->>'path' IS NULL OR c.body->>'path'=$3->>'path')
 AND ($3->>'stance' IS NULL OR c.body->>'stance'=$3->>'stance')
 AND ($3->>'source_entry' IS NULL OR c.body->>'source_entry'=$3->>'source_entry')
 AND ($3->>'tag_id' IS NULL OR EXISTS(SELECT 1 FROM call_tags ct WHERE ct.owner_id=c.owner_id AND ct.call_id=c.id AND ct.tag_id=($3->>'tag_id')::uuid AND ($3->>'tag_phase' IS NULL OR ct.phase=$3->>'tag_phase')))
 AND ($3->>'playbook_id' IS NULL OR EXISTS(SELECT 1 FROM adoptions a WHERE a.owner_id=c.owner_id AND a.call_id=c.id AND a.playbook_id=($3->>'playbook_id')::uuid))
 AND ($3->>'adoption' IS NULL OR CASE $3->>'adoption'
 WHEN 'planned' THEN EXISTS(SELECT 1 FROM adoptions a WHERE a.owner_id=c.owner_id AND a.call_id=c.id)
 WHEN 'executed' THEN EXISTS(SELECT 1 FROM execution_links e WHERE e.owner_id=c.owner_id AND e.call_id=c.id AND e.relation='executed' AND NOT EXISTS(SELECT 1 FROM execution_links n WHERE n.owner_id=e.owner_id AND n.supersedes=e.id))
 WHEN 'not_executed' THEN EXISTS(SELECT 1 FROM execution_links e WHERE e.owner_id=c.owner_id AND e.call_id=c.id AND e.relation='rejected' AND NOT EXISTS(SELECT 1 FROM execution_links n WHERE n.owner_id=e.owner_id AND n.supersedes=e.id))
 WHEN 'unknown' THEN NOT EXISTS(SELECT 1 FROM execution_links e WHERE e.owner_id=c.owner_id AND e.call_id=c.id AND e.relation IN ('executed','rejected')) ELSE false END)
), claims AS (
 SELECT c.*,cr.rule,(cr.n-1)::int AS claim_no,o.id AS outcome_id,o.result,a.state AS processing_state,a.reason AS processing_reason,
 CASE WHEN c.voided THEN 'voided' WHEN c.body->>'original_claimed_at' IS NOT NULL THEN 'historical_unverified'
 WHEN c.group_status='suggested' AND $4='episode_rule' THEN 'episode_unconfirmed'
 WHEN c.formation_case AND $3->>'playbook_id' IS NOT NULL THEN 'formation_not_subsequent_validation'
 WHEN cr.rule->>'template'='T0' THEN 'no_criteria' WHEN a.state='awaiting_input' THEN 'criteria_unconfirmed' ELSE NULL END AS exclusion
 FROM src c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(COALESCE(c.body->'criteria','[]'))=0 THEN '[{"template":"T0","version":"criteria-v1"}]'::jsonb ELSE c.body->'criteria' END) WITH ORDINALITY cr(rule,n)
 LEFT JOIN outcome_heads h ON h.owner_id=$1 AND h.call_id=c.id AND h.claim_no=cr.n-1
 LEFT JOIN outcomes o ON o.owner_id=h.owner_id AND o.id=h.outcome_id
 LEFT JOIN assessments a ON a.owner_id=$1 AND a.call_id=c.id AND a.claim_no=cr.n-1
)
INSERT INTO set_sample_members(owner_id,run_id,ordinal,call_id,claim_no,episode_id,submitted_at,signature,state,processing_state,eligible,selected,exclusion_reason,body)
SELECT $1,$2,row_number() OVER(ORDER BY submitted_at,id,claim_no),id,claim_no,
 CASE WHEN group_status IN ('explicit','confirmed') AND $4='episode_rule' THEN episode_id ELSE NULL END,
 submitted_at,encode(sha256(convert_to(jsonb_build_object('criteria',rule-'selected_by','instrument',instrument,'market',market,'calendar','natural_hours','price_policy','asof_last_eligible_trade')::text,'UTF8')),'hex'),
 COALESCE(result->>'state',CASE WHEN rule->>'template'='T0' THEN 'no_criteria' ELSE 'pending' END),processing_state,exclusion IS NULL,
 COALESCE(jsonb_array_length($3->'result_states'),0)=0 OR ($3->'result_states') ? COALESCE(result->>'state',CASE WHEN rule->>'template'='T0' THEN 'no_criteria' ELSE 'pending' END),
 exclusion,jsonb_build_object('criteria',rule,'instrument',instrument,'market',market,'timeframe',timeframe,'outcome_id',outcome_id,'result',result,'processing_reason',processing_reason,'voided',voided,'historical',body->'original_claimed_at','classification',jsonb_build_object('path',body->'path','stance',body->'stance','source_entry',body->'source_entry'))
FROM claims
