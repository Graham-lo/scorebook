CREATE TABLE knowledge_repair_cursors(
 owner_id uuid PRIMARY KEY REFERENCES users(id),source_kind text NOT NULL DEFAULT '',source_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
 next_run_at timestamptz NOT NULL DEFAULT now(),last_completed_at timestamptz
);
CREATE INDEX knowledge_dirty_oldest ON knowledge_dirty(owner_id,changed_at,source_kind,source_id);
