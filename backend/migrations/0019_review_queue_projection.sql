-- Rebuildable queue state keeps long-used review queues independent of the number of past reviews.
CREATE TABLE review_queue_projection(
 owner_id uuid NOT NULL,call_id uuid NOT NULL,submitted_at timestamptz NOT NULL,voided boolean NOT NULL,
 base_bucket text NOT NULL,latest_review_id uuid,reviewed_at timestamptz,draft_revision bigint,draft_saved_at timestamptz,
 snoozed_until timestamptz,preference_revision bigint,
 PRIMARY KEY(owner_id,call_id),FOREIGN KEY(owner_id,call_id) REFERENCES calls(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX review_queue_bucket ON review_queue_projection(owner_id,base_bucket,submitted_at DESC,call_id DESC) WHERE NOT voided;
CREATE INDEX review_queue_all ON review_queue_projection(owner_id,submitted_at DESC,call_id DESC) WHERE NOT voided;
CREATE INDEX review_queue_reminder ON review_queue_projection(owner_id,snoozed_until,submitted_at DESC,call_id DESC) WHERE NOT voided AND snoozed_until IS NOT NULL;
CREATE VIEW review_queue_source AS
 SELECT c.owner_id,c.id AS call_id,c.submitted_at,st.voided,
 CASE WHEN d.call_id IS NOT NULL THEN 'in_progress'
 WHEN latest.id IS NULL OR EXISTS(SELECT 1 FROM outcome_heads h JOIN outcomes o ON o.owner_id=h.owner_id AND o.id=h.outcome_id
 WHERE h.owner_id=c.owner_id AND h.call_id=c.id AND (o.kind='data_revision' OR o.result->>'state'<>'no_criteria')
 AND NOT EXISTS(SELECT 1 FROM review_outcome_refs rr WHERE rr.owner_id=c.owner_id AND rr.review_id=latest.id AND rr.outcome_id=h.outcome_id))
 THEN 'needs_review' ELSE 'completed' END AS base_bucket,
 latest.id AS latest_review_id,latest.created_at AS reviewed_at,d.revision AS draft_revision,d.updated_at AS draft_saved_at,p.snoozed_until,p.revision AS preference_revision
 FROM calls c JOIN call_state st ON st.owner_id=c.owner_id AND st.call_id=c.id
 LEFT JOIN review_drafts d ON d.owner_id=c.owner_id AND d.call_id=c.id
 LEFT JOIN review_preferences p ON p.owner_id=c.owner_id AND p.call_id=c.id
 LEFT JOIN LATERAL(SELECT id,created_at FROM reviews r WHERE r.owner_id=c.owner_id AND r.call_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) latest ON true;
INSERT INTO review_queue_projection SELECT * FROM review_queue_source;
