// 「这条记录此刻拿哪一张当现场图」——这件事的判断全在这里，界面只照着摆。
//
// 账本的不可变性护的是证据本身：截图的字节、sha256、size、uploaded_at 永远不
// 许改，附件永远不许硬删。它不护「此刻拿哪一张当现场图」——那是个判断，判断可
// 以改正。所以换图是合法的，换下来的那张留着，随时指得回来。
//
// 这里每一个函数在后端还没部署换图那一版时都要给出「今天的样子」：新字段整片
// 缺失，算出来就是 0 个新块、0 张换下来的图、没有任何常驻说明。index.ts 里那
// 几处渲染是照 `sceneBlocks()` 一条一个节点摆的，所以「旧后端一个新元素都不多」
// 这句话在 test/scene.test.ts 里是可以证的，不是嘴上说。

import type { Attachment, SupersededScene } from '../../api/types'

/**
 * 这几项 `CallDetail` 都有（后三项是可缺的）。这里只收用得着的，测试就不必为了
 * 试一句判断去伪造一整条记录。
 */
export interface SceneFacts {
  attachments: Attachment[]
  voided: boolean
  scene_replaced_after_submission?: boolean
  superseded_scenes?: SupersededScene[]
}

/**
 * 事后换的图，标一个词。这是事实，不是解释：这张图是记录成立之后才换上来的，
 * 「找」那一页的证据池不收它。
 */
export const SCENE_REPLACED_NOTE = '事后换的图'

/**
 * 「换一张现场图」这个入口出不出现。
 *
 * 作废的记录不给换。一张现场图都没有的记录也不从这里补第一张——那是「这条没留
 * 图」，是另一回事，不该混进「换」这个动作里。
 *
 * 注意这一句只读今天就有的字段，所以后端还是旧版时按钮照常出现（旧后端会 404，
 * 那时走 writeFailed 报错即可，不必特意探测）。
 */
export function canReplaceScene(d: SceneFacts): boolean {
  if (d.voided) return false
  return d.attachments.some((a) => a.kind === 'scene')
}

/**
 * 这张图还该不该在主看图区里露面。
 *
 * 换下来的现场图收进「换下来的图」那一段，不在主看图区里跟生效的那张并排——不
 * 然换完图的人在第一格看到的还是旧图（主看图区按 uploaded_at 升序取第一张），
 * 会以为没换成。别的种类一概照旧。
 *
 * `superseded_at` 缺失（旧后端）和为 null（还在生效）都是 true，所以旧后端下这
 * 一句一个附件都筛不掉，页面跟今天逐字一样。
 */
export function inMainViewer(a: Attachment): boolean {
  return !(a.kind === 'scene' && Boolean(a.superseded_at))
}

/** 换下来的那几张。字段缺失、不是数组、条目缺 id，一律当作没有。 */
export function supersededScenes(d: SceneFacts): SupersededScene[] {
  const rows = d.superseded_scenes
  if (!Array.isArray(rows)) return []
  return rows.filter(
    (row): row is SupersededScene =>
      Boolean(row) && typeof row.attachment_id === 'string' && row.attachment_id.length > 0,
  )
}

/**
 * 现场图那一格因为换图多出来的东西，一条一个节点。空数组就是「一个新元素都不
 * 多」——旧后端必须落在这里。
 */
export type SceneBlock =
  | { kind: 'replaced-note'; text: string }
  | { kind: 'superseded'; label: string; items: SupersededScene[] }

export function sceneBlocks(d: SceneFacts): SceneBlock[] {
  const out: SceneBlock[] = []
  // 只认 true。缺失、null、undefined 都是「没这回事」，不是「不知道」。
  if (d.scene_replaced_after_submission === true) {
    out.push({ kind: 'replaced-note', text: SCENE_REPLACED_NOTE })
  }
  const items = supersededScenes(d)
  if (items.length) {
    out.push({ kind: 'superseded', label: `换下来的图（${items.length} 张）`, items })
  }
  return out
}

/** 上面那两种块各取一条，省掉调用处的类型收窄。 */
export function replacedNote(d: SceneFacts): string | null {
  const block = sceneBlocks(d).find((b) => b.kind === 'replaced-note')
  return block && block.kind === 'replaced-note' ? block.text : null
}

export function supersededBlock(
  d: SceneFacts,
): { label: string; items: SupersededScene[] } | null {
  const block = sceneBlocks(d).find((b) => b.kind === 'superseded')
  return block && block.kind === 'superseded' ? { label: block.label, items: block.items } : null
}
