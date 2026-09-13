import type { TagRecord } from '../api/types'

/** 同名标签是定义的版本；记录仍引用旧版时，也属于这同一类局面。 */
export function latestTags(tags: TagRecord[]): TagRecord[] {
  const latest = new Map<string, TagRecord>()
  for (const tag of tags) {
    const previous = latest.get(tag.name)
    if (!previous || tag.version > previous.version ||
      (tag.version === previous.version && tag.created_at > previous.created_at)) latest.set(tag.name, tag)
  }
  return [...latest.values()]
}

export function inTagGroup(tags: TagRecord[], tag: TagRecord): boolean {
  return tags.some(current => current.name === tag.name)
}
