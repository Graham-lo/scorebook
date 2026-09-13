-- Version derived OCR labels without changing saved screenshot locations.
ALTER TABLE attachment_reads ADD COLUMN recognition_version smallint NOT NULL DEFAULT 1;
