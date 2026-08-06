import { access, mkdir, readdir, rename, rm, rmdir, statfs, writeFile } from 'node:fs/promises'
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

/** 移动到目标目录；重名自动加 (n)。返回最终路径。 */
export async function moveWithCollision(from, toDir) {
  await mkdir(toDir, { recursive: true })
  const target = await ensureUniquePath(join(toDir, basename(from)))
  await rename(from, target)
  return target
}

/** 直接改名/移动（不做重名避让），供两阶段改名的临时名阶段使用。 */
export async function directRename(from, to) {
  await rename(from, to)
  return to
}

/** 同目录改名；与自身相同则跳过，与其他文件重名自动加 (n)。返回最终路径。 */
export async function renameWithCollision(from, newName) {
  const dir = dirname(from)
  const desired = join(dir, newName)
  if (desired === from) return from
  const target = await ensureUniquePath(desired)
  await rename(from, target)
  return target
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
