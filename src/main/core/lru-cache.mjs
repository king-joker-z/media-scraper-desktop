/**
 * 轻量 LRU 缓存：基于 Map 插入序实现。
 * get 命中时提升为最新；set 超限后逐条淘汰最旧条目（而不是整体 clear 全清），
 * 避免热点数据被周期性清空导致命中率骤降（探测/哈希缓存共用）。
 */
export function createLruCache(maxEntries = 1000) {
  const limit = Math.max(1, Math.round(maxEntries))
  const map = new Map()
  return {
    get(key) {
      if (!map.has(key)) return undefined
      const value = map.get(key)
      map.delete(key)
      map.set(key, value)
      return value
    },
    set(key, value) {
      if (map.has(key)) map.delete(key)
      map.set(key, value)
      while (map.size > limit) {
        map.delete(map.keys().next().value)
      }
    },
    has: (key) => map.has(key),
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
    get size() {
      return map.size
    }
  }
}
