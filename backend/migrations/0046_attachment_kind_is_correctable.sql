-- 截图派什么用场是人事后才看得准的判断，不是证据本身：同板块对比图当初按
-- scene 传了，改成 reference 应该改得动。字节、尺寸、哈希、上传时间照旧一格
-- 都不能动，所以 attachments 上的整行不可变换成"只有 kind 一列可改"。
CREATE FUNCTION reject_attachment_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW)-'kind' IS DISTINCT FROM to_jsonb(OLD)-'kind' THEN
    RAISE EXCEPTION 'immutable evidence; only the attachment kind may be corrected';
  END IF;
  IF NEW.kind NOT IN ('scene','supplement','reference') THEN
    RAISE EXCEPTION 'attachment kind must be scene, supplement or reference';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER immutable_update ON attachments;
CREATE TRIGGER attachment_kind_only BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION reject_attachment_update();
