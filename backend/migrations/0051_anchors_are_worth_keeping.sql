-- 定位不再只留一个分数：读出来的锚点（时间轴拟合、价格轴、极值、猜到的时区）
-- 一起存下来，下一次重温、手动改钉或者复核都能看见这次是凭什么定的。
ALTER TABLE attachment_locations ADD COLUMN anchor jsonb;

-- 截图的时区是这个人的习惯，不是这张图的属性：第一次确认之后记住，后面每张图
-- 都先按这个偏好去试（§5.2 第 6 步）。
CREATE TABLE user_preferences(
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,key)
);
