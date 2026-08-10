import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  writeFile
} from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, extname, join } from 'node:path'

/**
 * 执行层唯一写入口：所有模块的删除/移动/改名/写文件必须经由本文件，
 * 以便统一审计、重名处理与隐藏内容保护（见冻结稿 §2.5/§2.7）。
 */

export async function pathExists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/** 永久删除文件或目录，不可恢复。调用前必须已在 UI 完成风险确认。 */
export async function permanentDelete(target) {
  await rm(target, { force: true, recursive: true })
}

/* ---------------- 回收站删除（F1：可恢复删除） ---------------- */

// 由主进程注入 Electron shell.trashItem；未注入时（纯 Node 测试环境）回退永久删除
let trashImpl = null

/** 注入回收站实现（主进程启动时调用）：(target: string) => Promise<void> */
export function setTrashImpl(fn) {
  trashImpl = typeof fn === 'function' ? fn : null
}

/**
 * 删除到系统回收站（可从回收站恢复）。
 * 未注入实现或回收站不可用（部分 Linux 环境）时回退为永久删除——与旧行为一致。
 */
export async function deleteToTrash(target) {
  if (!trashImpl) {
    await permanentDelete(target)
    return
  }
  try {
    await trashImpl(target)
  } catch {
    await permanentDelete(target)
  }
}

/**
 * 若目标路径已存在，自动追加 " (n)" 后缀直到唯一（冻结稿 §2.7）。
 * 返回最终可用路径。
 */
export async function ensureUniquePath(target) {
  if (!(await pathExists(target))) return target
  const dir = dirname(target)
  const ext = extname(target)
  const stem = basename(target, ext)
  for (let n = 1; ; n += 1) {
    const candidate = join(dir, `${stem} (${n})${ext}`)
    if (!(await pathExists(candidate))) return candidate
  }
}

/**
 * 移动文件：优先 rename（同设备秒级）；跨设备（EXDEV，如工作区在移动硬盘、
 * 归档目标在 NAS）自动回退为流式复制 + 大小校验 + 删源，校验失败不丢源文件。
 * @param {string} from 源路径
 * @param {string} to 目标路径
 * @param {object} [options]
 * @param {(copiedBytes: number, totalBytes: number) => void} [options.onProgress] 拷贝进度回调
 * @param {AbortSignal} [options.signal] 取消信号（取消后删除不完整的目标副本）
 */
export async function moveFile(from, to, { onProgress, signal } = {}) {
  try {
    await rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    // 跨设备：先复制到同目录临时文件再 rename 落位——取消/崩溃只残留 .msd-part
    // 临时件（可安全重试或清理），绝不会留下名为目标文件的不完整副本。
    const partPath = `${to}.msd-part`
    try {
      const srcStat = await stat(from)
      const total = srcStat.size
      let copied = 0
      await pipeline(
        createReadStream(from),
        async function* (source) {
          for await (const chunk of source) {
            if (signal?.aborted) throw new Error('已取消')
            copied += chunk.length
            onProgress?.(copied, total)
            yield chunk
          }
        },
        createWriteStream(partPath)
      )
      const dstStat = await stat(partPath)
      if (srcStat.size !== dstStat.size) {
        throw new Error(`跨磁盘移动校验失败（大小不一致）：${from}`)
      }
      await rename(partPath, to)
    } catch (copyError) {
      // 取消/失败兜底清理：不留部分拷贝（含异常前已落位的极端情况）
      await rm(partPath, { force: true }).catch(() => {})
      throw copyError
    }
    await rm(from)
  }
}

/**
 * 清理目录下跨设备移动残留的临时件（*.msd-part）。
 * 取消已被 moveFile 兜底清理，这里兜底的是进程崩溃等极端场景。
 * 返回清理的路径列表。
 */
export async function cleanMovePartials(dir) {
  const cleaned = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return cleaned
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      cleaned.push(...(await cleanMovePartials(full)))
    } else if (entry.isFile() && entry.name.endsWith('.msd-part')) {
      await rm(full, { force: true }).catch(() => {})
      cleaned.push(full)
    }
  }
  return cleaned
}

/** 移动到目标目录；重名自动加 (n)。返回最终路径。 */
export async function moveWithCollision(from, toDir, options) {
  await mkdir(toDir, { recursive: true })
  const target = await ensureUniquePath(join(toDir, basename(from)))
  await moveFile(from, target, options)
  return target
}

/** 直接改名/移动（不做重名避让），供两阶段改名的临时名阶段使用。 */
export async function directRename(from, to) {
  await rename(from, to)
  return to
}

/** 同目录改名；与自身相同则跳过，与其他文件重名自动加 (n)。返回最终路径。 */
export async function renameWithCollision(from, newName, options) {
  const dir = dirname(from)
  const desired = join(dir, newName)
  if (desired === from) return from
  const target = await ensureUniquePath(desired)
  await moveFile(from, target, options)
  return target
}

// dirSizeBytes 单目录内 stat 并发批大小（I/O 并发显著加速大目录）
const SIZE_STAT_BATCH = 32

/** 目录递归总大小（字节）；目录不存在或无权限返回 0，不抛错。文件 stat 批内并发。 */
export async function dirSizeBytes(dir) {
  let total = 0
  async function visit(current) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs = []
    const files = []
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) subdirs.push(full)
      else if (entry.isFile()) files.push(full)
    }
    for (let i = 0; i < files.length; i += SIZE_STAT_BATCH) {
      const sizes = await Promise.all(
        files.slice(i, i + SIZE_STAT_BATCH).map(async (full) => {
          try {
            return (await stat(full)).size
          } catch {
            return 0 // 竞态消失的文件跳过
          }
        })
      )
      for (const size of sizes) total += size
    }
    // 子目录并行递归（缓存/临时目录通常较浅，无需限流）
    await Promise.all(subdirs.map(visit))
  }
  await visit(dir)
  return total
}

/** 确保目录存在（递归创建）。 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

/** 目标目录所在磁盘剩余空间（字节）。 */
export async function diskFreeBytes(dir) {
  const stats = await statfs(dir)
  return Number(stats.bavail) * Number(stats.bsize)
}

/** 读取目录条目名；目录不存在返回空数组。 */
export async function listDirNames(dir) {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/** 写文本文件（自动建目录）。 */
export async function writeTextFile(target, content) {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
  return target
}

/** 读文本文件（utf8）；供 modules 读取 journal/日志等，与写入口同文件便于审计。 */
export async function readTextFile(target) {
  return readFile(target, 'utf8')
}

/**
 * 操作系统生成的垃圾文件（可安全删除，用户数据不受影响）：
 * macOS 的 .DS_Store / ._AppleDouble、Windows 的 Thumbs.db / desktop.ini。
 */
const JUNK_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini'])
export const isJunkFileName = (name) =>
  JUNK_FILE_NAMES.has(name.toLowerCase()) || name.startsWith('._')

/**
 * 自底向上删除 root 下的空子目录（不删 root 自身）。
 * 规则：
 * - 目录只剩系统垃圾文件 → 先删垃圾再删目录（用户明确要求清理空文件夹）；
 * - 目录含有任何其他内容（含真实隐藏文件）→ 保留（冻结稿 §2.5 隐藏保护）。
 * 返回被删除目录的绝对路径列表。
 */
export async function removeEmptyDirs(root) {
  const removed = []
  async function visit(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) await visit(join(dir, entry.name))
      }
      if (dir === root) return
      const remaining = await readdir(dir, { withFileTypes: true })
      if (remaining.length === 0) {
        await rmdir(dir)
        removed.push(dir)
        return
      }
      const junkOnly = remaining.every((entry) => entry.isFile() && isJunkFileName(entry.name))
      if (junkOnly) {
        for (const entry of remaining) await rm(join(dir, entry.name), { force: true })
        await rmdir(dir)
        removed.push(dir)
      }
    } catch {
      // 无权限/竞态消失的目录跳过，不中断清理
    }
  }
  await visit(root)
  return removed
}
