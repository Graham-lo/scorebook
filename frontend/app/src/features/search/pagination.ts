/** Pages share one frozen ranking. Never sort or discard previously seen items. */
export function resultPage<T>(items: readonly T[], requested: number, size: number): { items: T[]; index: number; count: number } {
  const count = Math.max(1, Math.ceil(items.length / size))
  const index = Math.max(0, Math.min(requested, count - 1))
  return { items: items.slice(index * size, (index + 1) * size), index, count }
}
