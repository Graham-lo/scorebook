-- Constant-size book snapshots share an append-only closed-cycle epoch.
-- Unlike copying historical segment arrays, each import adds O(books + new cycles).
CREATE TABLE trade_book_snapshots(
 owner_id uuid NOT NULL,run_id uuid NOT NULL,symbol text NOT NULL,position_side text NOT NULL,
 epoch_id uuid NOT NULL,closed_through bigint NOT NULL,open_cycle_id uuid,
 PRIMARY KEY(owner_id,run_id,symbol,position_side),
 FOREIGN KEY(owner_id,run_id) REFERENCES trade_projection_runs(owner_id,id) ON DELETE CASCADE DEFERRABLE,
 FOREIGN KEY(owner_id,open_cycle_id) REFERENCES trade_cycles(owner_id,id) DEFERRABLE
);
CREATE TABLE trade_epoch_cycles(
 owner_id uuid NOT NULL,epoch_id uuid NOT NULL,symbol text NOT NULL,position_side text NOT NULL,ordinal bigint NOT NULL,cycle_id uuid NOT NULL,
 PRIMARY KEY(owner_id,epoch_id,symbol,position_side,ordinal),
 FOREIGN KEY(owner_id,cycle_id) REFERENCES trade_cycles(owner_id,id) ON DELETE CASCADE DEFERRABLE
);
WITH origins AS(SELECT DISTINCT ON(owner_id,run_id,symbol,position_side) owner_id,run_id,symbol,position_side,source_run_id AS epoch_id FROM trade_projection_segments ORDER BY owner_id,run_id,symbol,position_side,first_ordinal), members AS(SELECT p.owner_id,p.run_id,p.symbol,p.position_side,c.id,c.ordinal,c.body->>'closed_at' AS closed_at FROM trade_projection_segments p JOIN trade_cycles c ON c.owner_id=p.owner_id AND c.run_id=p.source_run_id AND c.symbol=p.symbol AND c.position_side=p.position_side AND c.ordinal BETWEEN p.first_ordinal AND p.last_ordinal)
INSERT INTO trade_book_snapshots SELECT o.owner_id,o.run_id,o.symbol,o.position_side,o.epoch_id,COALESCE(max(m.ordinal) FILTER(WHERE closed_at IS NOT NULL),-1),(array_agg(m.id ORDER BY m.ordinal DESC) FILTER(WHERE closed_at IS NULL))[1] FROM origins o JOIN members m USING(owner_id,run_id,symbol,position_side) GROUP BY o.owner_id,o.run_id,o.symbol,o.position_side,o.epoch_id;
INSERT INTO trade_epoch_cycles
SELECT DISTINCT ON(s.owner_id,s.epoch_id,s.symbol,s.position_side,c.ordinal) s.owner_id,s.epoch_id,s.symbol,s.position_side,c.ordinal,c.id FROM trade_book_snapshots s JOIN trade_projection_segments p ON p.owner_id=s.owner_id AND p.run_id=s.run_id AND p.symbol=s.symbol AND p.position_side=s.position_side JOIN trade_cycles c ON c.owner_id=p.owner_id AND c.run_id=p.source_run_id AND c.symbol=p.symbol AND c.position_side=p.position_side AND c.ordinal BETWEEN p.first_ordinal AND p.last_ordinal WHERE c.body->>'closed_at' IS NOT NULL ORDER BY s.owner_id,s.epoch_id,s.symbol,s.position_side,c.ordinal,c.id;
DROP TABLE trade_projection_segments;
UPDATE trade_projection_checkpoints SET body=jsonb_set(body,'{protocol}','"trade-projector-v2"');
UPDATE trade_projection_checkpoints SET body=jsonb_set(body,'{state,last_order,1}',to_jsonb(body->'state'->'last_order'->>1)) WHERE jsonb_typeof(body->'state'->'last_order')='array';
