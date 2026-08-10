import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { createLruCache } from './lru-cache.mjs'

/**
 * 文件内容指纹：大小 + 头部样本 + 中部样本 + 尾部样本 的 MD5。
 * 用于视频去重的快速判同（完整哈希太贵；头/中/尾三点采样可避免
 * “仅头部相同的重打包文件”被误判为重复，可靠性足够）。
 */
export async function hashFileSample(filePath, sampleSize = 65536) {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const hash = createHash('md5')
    hash.update(String(size))
    const readAt = async (offset, length) => {
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
      hash.update(buffer)
    }
    const head = Math.min(sampleSize, size)
    if (head > 0) await readAt(0, head)
    if (size > sampleSize * 2) {
      // 中部采样：头尾相同但中段不同的文件不会被误判
      await readAt(Math.floor((size - sampleSize) / 2), sampleSize)
    }
    if (size > sampleSize) await readAt(size - sampleSize, sampleSize)
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/* ---------------- 哈希缓存：按 path+mtime+size 命中，LRU 淘汰 ---------------- */

const HASH_CACHE_MAX = 2000
const hashCache = createLruCache(HASH_CACHE_MAX)

/**
 * 带缓存的采样哈希：文件未变化（mtime/size 相同）直接返回缓存，
 * 去重模块二次扫描时免重复读盘。hashFn 可注入便于测试。
 */
export async function hashFileSampleCached(filePath, sampleSize = 65536, hashFn = hashFileSample) {
  const info = await stat(filePath)
  const key = `${filePath}:${info.mtimeMs}:${info.size}`
  const cached = hashCache.get(key)
  if (cached) return cached
  const hash = await hashFn(filePath, sampleSize)
  hashCache.set(key, hash)
  return hash
}

export function clearHashCache() {
  hashCache.clear()
}
