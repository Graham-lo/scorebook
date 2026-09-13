-- Content identity is tenant scoped. Metadata/purpose can remain separate.
CREATE INDEX attachments_content_lookup ON attachments(owner_id,sha256,kind);
CREATE TABLE screenshot_ocr_cache(
 owner_id uuid NOT NULL, sha256 text NOT NULL, attachment_id uuid NOT NULL,
 protocol text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(owner_id,sha256,protocol),
 FOREIGN KEY(owner_id,attachment_id) REFERENCES attachments(owner_id,id) ON DELETE CASCADE
);
