ALTER TABLE attachment_locations ADD COLUMN matched_by text NOT NULL DEFAULT 'user' CHECK(matched_by IN ('user','auto'));
