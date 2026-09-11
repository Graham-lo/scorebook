UPDATE public_market.generations SET coverage=coverage||jsonb_build_object('generation_id',id) WHERE coverage IS NOT NULL;
UPDATE history_indexes i SET coverage=g.coverage FROM public_market.generations g WHERE i.generation_id=g.id AND i.status='ready';
INSERT INTO review_outcome_refs SELECT r.owner_id,r.id,o.id FROM reviews r JOIN outcomes o ON o.owner_id=r.owner_id AND o.call_id=r.call_id AND o.created_at<=r.created_at AND o.kind<>'rule_replay' ON CONFLICT DO NOTHING;
