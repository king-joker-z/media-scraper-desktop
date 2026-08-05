import { access, mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
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

/** 同目录改名；与自身相同则跳过，与其他文件重名自动加 (n)。返回最终路径。 */
export async function renameWithCollision(from, newName) {
  const dir = dirname(from)
  const desired = join(dir, newName)
  if (desired === from) return from
  const target = await ensureUniquePath(desired)
  await rename(from, target)
  return target
}

/** 写文本文件（自动建目录）。 */
export async function writeTextFile(target, content) {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
  return target
}

/**
 * 自底向上删除 root 下的空子目录（不删 root 自身）。
 * 目录只要还含有任何条目（包括隐藏文件）就不会被删 —— 冻结稿 §2.5 的隐藏保护由此保证。
 * 返回被删除目录的绝对路径列表。
 */
export async function removeEmptyDirs(root) {
  const removed = []
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(join(dir, entry.name))
    }
    if (dir === root) return
    const remaining = await readdir(dir)
    if (remaining.length === 0) {
      await rmdir(dir)
      removed.push(dir)
    }
  }
  await visit(root)
  return removed
}
