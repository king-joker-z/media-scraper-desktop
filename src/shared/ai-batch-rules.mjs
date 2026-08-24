/** 按父目录分组、在不超过批大小的前提下尽可能不拆分同目录条目。 */
export function buildAiChunks(entries, batchSize = 40) {
  const numericSize = Number(batchSize)
  const limit = Number.isFinite(numericSize)
    ? Math.min(100, Math.max(1, Math.round(numericSize)))
    : 40
  const groups = []
  const byFolder = new Map()
  for (const entry of entries) {
    const folder = entry.file.parentFolder ?? ''
    if (!byFolder.has(folder)) {
      const group = []
      byFolder.set(folder, group)
      groups.push(group)
    }
    byFolder.get(folder).push(entry)
  }

  const chunks = []
  let current = []
  const flush = () => {
    if (current.length) chunks.push(current)
    current = []
  }
  for (const group of groups) {
    if (group.length > limit) {
      flush()
      for (let offset = 0; offset < group.length; offset += limit) {
        chunks.push(group.slice(offset, offset + limit))
      }
      continue
    }
    if (current.length + group.length > limit) flush()
    current.push(...group)
  }
  flush()
  return chunks
}
