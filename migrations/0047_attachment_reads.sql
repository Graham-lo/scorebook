-- 截图自己写着它是哪个品种。同板块对比图是常态：一条 SK 海力士的记录挂着三张
-- 1h 图，其中两张是闪迪和美光，定位面板却把三张都默认成记录自己的标的，每次都
-- 得人手改回来。图上那行代码 OCR 一直读得出来，只是从没人问过它。
--
-- 读一次要一枚视觉许可加一个子进程，而定位面板开着的时候 GET locate 两秒轮询一
-- 次，所以读到的东西必须记下来，一张图至多读一次。
--
-- 有行就是「看过了」，symbol/interval 两格全空也算看过：认不出来的图不会每轮再
-- 被读一遍。市场不存这里——品种认出来之后市场从 instrument_catalog 现查，catalog
-- 改了市场就跟着改，这张表只记 OCR 看见的东西。
CREATE TABLE attachment_reads(
  owner_id uuid NOT NULL, attachment_id uuid NOT NULL,
  symbol text, interval text, read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,attachment_id),
  FOREIGN KEY(owner_id,attachment_id) REFERENCES attachments(owner_id,id) ON DELETE CASCADE
);
