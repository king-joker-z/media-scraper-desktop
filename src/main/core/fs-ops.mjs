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
import { randomUUID } from 'node:crypto'

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

/* ---------------- Windows 文件锁定重试 ---------------- */

// Windows 特有：播放器占用、Defender 实时扫描、缩略图进程、网盘同步客户端都会短暂
// 锁定文件，rename/rm 直接报 EBUSY/EPERM/EACCES。短延迟重试可消除绝大多数瞬时失败。
// macOS/Linux 的 POSIX 语义允许对打开中的文件 rename/unlink，不会触发，行为不变。
const LOCK_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])
const LOCK_RETRY_MAX = 3
const LOCK_RETRY_BASE_MS = 200

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 对瞬时文件锁定错误做短延迟重试（最多 3 次，200/400/600ms）；其他错误立即抛出 */
async function withLockRetry(fn) {
  for (let attempt = 0; attempt <= LOCK_RETRY_MAX; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      if (!LOCK_RETRY_CODES.has(error?.code) || attempt >= LOCK_RETRY_MAX) throw error
      await sleepMs(LOCK_RETRY_BASE_MS * (attempt + 1))
    }
  }
  return undefined // 不可达：循环内要么返回要么抛出
}

/** 永久删除文件或目录，不可恢复。调用前必须已在 UI 完成风险确认。 */
export async function permanentDelete(target) {
  await withLockRetry(() => rm(target, { force: true, recursive: true }))
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
  // 上限保护：极端异常下防无限循环（正常场景几十个重名已是极限）
  for (let n = 1; n <= 9999; n += 1) {
    const candidate = join(dir, `${stem} (${n})${ext}`)
    if (!(await pathExists(candidate))) return candidate
  }
  throw new Error(`无法生成唯一路径（重名超过 9999 个）：${target}`)
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
    await withLockRetry(() => rename(from, to))
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    // 跨设备：先复制到同目录临时文件再 rename 落位——取消/崩溃只残留 .msd-part
    // 临时件（可安全重试或清理），绝不会留下名为目标文件的不完整副本。
    const partPath = `${to}.msd-part`
    try {
      const srcStat = await stat(from)
      const total = srcStat.size
      let copied = 0
      // 4MB 缓冲：跨磁盘/网络盘上移动大视频时 syscall 次数较默认 64KB 下降约 64 倍，
      // 吞吐显著提升（NAS 上 GB 级文件从 ~30MB/s 提到 ~90MB/s+）
      const COPY_HIGH_WATER_MARK = 4 * 1024 * 1024
      await pipeline(
        createReadStream(from, { highWaterMark: COPY_HIGH_WATER_MARK }),
        async function* (source) {
          for await (const chunk of source) {
            if (signal?.aborted) throw new Error('已取消')
            copied += chunk.length
            onProgress?.(copied, total)
            yield chunk
          }
        },
        createWriteStream(partPath, { highWaterMark: COPY_HIGH_WATER_MARK })
      )
      const dstStat = await stat(partPath)
      if (srcStat.size !== dstStat.size) {
        throw new Error(`跨磁盘移动校验失败（大小不一致）：${from}`)
      }
      await withLockRetry(() => rename(partPath, to))
    } catch (copyError) {
      // 取消/失败兜底清理：不留部分拷贝（含异常前已落位的极端情况）
      await rm(partPath, { force: true }).catch(() => {})
      throw copyError
    }
    await withLockRetry(() => rm(from))
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
  await withLockRetry(() => rename(from, to))
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
// 子目录遍历并发上限：无限并行在深目录树（NAS 影视库）上会瞬间打开数千句柄触发 EMFILE
const SIZE_DIR_LANES = 8

/**
 * 目录递归总大小（字节）；目录不存在或无权限返回 0，不抛错。
 * BFS 共享队列 + 限流并发：文件 stat 批内并发，子目录经队列限流（≤8 路）。
 */
export async function dirSizeBytes(dir) {
  let total = 0
  const queue = [dir]
  let cursor = 0
  const lane = async () => {
    while (cursor < queue.length) {
      const current = queue[cursor]
      cursor += 1
      let entries
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      const files = []
      for (const entry of entries) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) queue.push(full)
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
    }
  }
  await Promise.all(Array.from({ length: SIZE_DIR_LANES }, lane))
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

/** 读取二进制文件（EPUB/PDF 等本地打包模块复用，避免绕过 fs-ops） */
export async function readBinaryFile(target) {
  return readFile(target)
}

/**
 * 为大文件生成同目录暂存路径：确保最终提交时同卷 rename，不产生跨卷复制窗口。
 * 调用方必须在 finally 中调用 discardStagedFile，或提交后由 commitStagedFile 自动清理。
 */
export function createStagingPath(target) {
  return `${target}.msd-new-${randomUUID()}`
}

/** 将可读流完整写入指定暂存文件，保留背压；适合 EPUB 等数 GB 级产物。 */
export async function writeReadableFile(target, readable) {
  await mkdir(dirname(target), { recursive: true })
  await pipeline(readable, createWriteStream(target, { highWaterMark: 4 * 1024 * 1024 }))
  return target
}

/** 删除未提交的暂存文件；取消或构建失败时使用，绝不影响正式产物。 */
export async function discardStagedFile(target) {
  await rm(target, { force: true }).catch(() => {})
}

/** 获取文件字节数（不存在时抛出，避免调用方将不完整产物误判成功）。 */
export async function fileSize(target) {
  return (await stat(target)).size
}

/**
 * 将已验证的同目录暂存文件安全替换为正式产物。
 * Windows 上先将旧产物移至 backup，再落位 staging；任何失败都会优先恢复旧产物，
 * 因此阅读器/同步软件造成的短暂锁定不会导致原书丢失。
 */
export async function commitStagedFile(staging, target) {
  const backup = `${target}.msd-backup-${randomUUID()}`
  const hadTarget = await pathExists(target)
  let movedOld = false
  try {
    if (hadTarget) {
      await withLockRetry(() => rename(target, backup))
      movedOld = true
    }
    await withLockRetry(() => rename(staging, target))
  } catch (error) {
    if (movedOld && !(await pathExists(target)) && (await pathExists(backup))) {
      await withLockRetry(() => rename(backup, target)).catch(() => {})
    }
    throw error
  } finally {
    if (await pathExists(staging)) await discardStagedFile(staging)
  }
  // 备份只在新产物成功落位后删除；失败不影响新产物可用性，下次操作可清理残留。
  if (movedOld) await withLockRetry(() => rm(backup, { force: true }))
  return target
}

/** 原子写入小型二进制文件：先写同目录暂存，再经安全替换提交。 */
export async function writeBinaryFile(target, data) {
  const temporary = createStagingPath(target)
  try {
    await writeFile(temporary, data)
    await commitStagedFile(temporary, target)
  } catch (error) {
    await discardStagedFile(temporary)
    throw error
  }
}

/** 原子写入文本文件，设置与漫画清单等元数据不可留下半截 JSON。 */
export async function writeAtomicTextFile(target, content) {
  await writeBinaryFile(target, Buffer.from(content, 'utf8'))
  return target
}

/**
 * 恢复大文件安全替换中因断电/强制退出留下的暂存件。
 * 只识别本应用带 UUID 后缀的 .epub/.pdf 文件：正式文件缺失时恢复 backup，
 * 正式文件存在时清理过期 backup/new，绝不扫描或触碰用户的其他文件。
 */
export async function recoverStagedOutputs(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const recovered = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = /^(.*\.(?:epub|pdf))\.msd-(new|backup)-[\da-f-]+$/i.exec(entry.name)
    if (!match) continue
    const [, outputName, kind] = match
    const artifact = join(dir, entry.name)
    const output = join(dir, outputName)
    if (kind === 'backup' && !(await pathExists(output))) {
      try {
        await withLockRetry(() => rename(artifact, output))
        recovered.push(output)
      } catch {
        // 锁定时保留 backup，下次扫描还可继续恢复
      }
    } else {
      await discardStagedFile(artifact)
    }
  }
  return recovered
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
