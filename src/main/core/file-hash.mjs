import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

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
