import { cpus } from 'node:os'
import sharp from 'sharp'

/**
 * 限制 sharp 的 libuv 线程数：sharp 的重活本来就在自己的线程池执行（不阻塞主进程事件循环），
 * 无需 Worker Thread（worker 内无法加载 asar 里的 sharp 原生模块，反而引入打包风险）。
 * 仅限制并发，避免大批量转图时打满 CPU 影响系统响应。
 */
sharp.concurrency(Math.max(2, Math.floor(cpus().length / 2)))

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg'])

export const isJpegName = (name) =>
  JPEG_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase())

/**
 * 将图片转换为 JPG（quality 90，mozjpeg）。
 * 返回写入的目标路径。调用方负责保证 target 不重名。
 */
export async function convertToJpg(source, target) {
  await sharp(source)
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(target)
  return target
}
