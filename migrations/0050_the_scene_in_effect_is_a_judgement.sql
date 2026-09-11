-- 哪一张场景图此刻在生效，是判断，不是证据。图贴错了得换得动。
--
-- 0046 已经说过一次同样的道理：截图派什么用场是人事后才看得准的判断，所以
-- attachments 从整行不可变放开成「只有 kind 一列可改」。这一次放开的东西比那
-- 还轻——一个字节、一个哈希、一个 uploaded_at 都不动，附件行也一行不删。改的
-- 只是「这条记录现在拿哪一张当场景图」，而那句话根本不长在附件上：同一张图
-- 原则上可以挂到不止一条记录上，说它「在生效」只有对着某一条记录才有意义。
-- 所以状态放在链接上，不放在附件上。
--
-- 三列：
--   attached_at   这条链接是什么时候挂上去的。必须单独有一列，不能拿
--                 attachments.uploaded_at 顶替：把一张旧图重新指回来当生效图
--                 时，它的 uploaded_at 是旧的，按那个排它永远翻不了身。
--   superseded_at NULL 就是正在生效。
--   superseded_by 被哪一张接替。
--
-- 回填只有一句话：既有的每一条链接都还在生效（superseded_at 保持 NULL），
-- attached_at 取这张附件的 uploaded_at。这一句是为了让迁移前后**谁在生效不变**：
-- 读的那一侧从前按 (a.uploaded_at, a.id) 升序取第一条，现在按
-- (l.attached_at, l.attachment_id) 升序取第一条，回填之后这两个键逐行相等，
-- 所以线上那条挂着两张 scene 的记录，重温挑的还是原来那一张。往后只有人显式
-- 换图才会有第二种结果。
--
-- 「一条记录至多一张生效的场景图」不拿唯一索引去保：索引看不见
-- attachments.kind，而把 kind 抄一份到链接表，又会因为 0046 允许改 kind 而立刻
-- 变味。这个不变量由换图那个事务保证（同一条记录上 FOR UPDATE 串行），读的那
-- 一侧仍然保留 ORDER BY ... LIMIT 1 兜底。

ALTER TABLE call_attachments ADD COLUMN attached_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE call_attachments ADD COLUMN superseded_at timestamptz;
ALTER TABLE call_attachments ADD COLUMN superseded_by uuid;
ALTER TABLE call_attachments ADD FOREIGN KEY(owner_id,superseded_by) REFERENCES attachments(owner_id,id);

UPDATE call_attachments l SET attached_at=a.uploaded_at
FROM attachments a WHERE a.owner_id=l.owner_id AND a.id=l.attachment_id;

CREATE INDEX call_attachments_in_effect ON call_attachments(owner_id,call_id,attached_at,attachment_id) WHERE superseded_at IS NULL;
