import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

/**
 * 文件内容指纹：大小 + 头部样本 + 尾部样本 的 MD5。
 * 用于视频去重的快速判同（完整哈希太贵，样本哈希对“下载了两次的同文件”足够可靠）。
 */
export async function hashFileSample(filePath, sampleSize = 65536) {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const hash = createHash('md5')
    hash.update(String(size))
    const head = Buffer.alloc(Math.min(sampleSize, size))
    if (head.length > 0) {
      await handle.read(head, 0, head.length, 0)
      hash.update(head)
    }
    if (size > sampleSize) {
      const tail = Buffer.alloc(sampleSize)
      await handle.read(tail, 0, sampleSize, size - sampleSize)
      hash.update(tail)
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
