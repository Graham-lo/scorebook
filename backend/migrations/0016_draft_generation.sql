-- The draft clock survives publication, preventing a delayed previous editor from overwriting a new review.
ALTER TABLE call_state ADD COLUMN draft_revision bigint NOT NULL DEFAULT 0;
UPDATE call_state s SET draft_revision=d.revision FROM review_drafts d WHERE s.owner_id=d.owner_id AND s.call_id=d.call_id;
