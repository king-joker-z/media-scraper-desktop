import { readdir, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeAtomicTextFile } from './fs-ops.mjs'

/**
 * 操作日志（冻结稿：永久删除不可恢复，留档可查）。
 * 每个执行任务落一份 JSON 到 userData/op-logs/。
 */

/** 最多保留的日志份数（超出后最旧的被清理，防止目录无限增长） */
export const OP_LOG_KEEP = 100

/** 清理旧日志：按文件名（ISO 时间戳可排序）保留最新 keep 份。返回删除的文件数。 */
export async function pruneOpLogs(dir, keep = OP_LOG_KEEP) {
  let files = []
  try {
    files = await readdir(dir)
  } catch {
    return 0
  }
  const sorted = files
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
  const stale = sorted.slice(Math.max(0, keep))
  for (const file of stale) {
    await rm(join(dir, file), { force: true }).catch(() => {})
  }
  return stale.length
}

export async function writeOpLog(dir, module, payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // 日志异步写入且跨模块可并行，同一毫秒不能复用同名文件，否则会丢失撤销依据。
  const file = join(dir, `${stamp}-${module}-${randomUUID()}.json`)
  await writeAtomicTextFile(
    file,
    JSON.stringify({ module, finishedAt: new Date().toISOString(), ...payload }, null, 2)
  )
  // 顺带修剪历史日志，失败不影响主流程
  await pruneOpLogs(dir).catch(() => 0)
  return file
}

/** 读取单份日志的完整内容；不存在/损坏返回 null。 */
export async function readOpLog(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** 回写 undoneAt 标记（一键撤销成功后防重复撤销）。 */
export async function markOpLogUndone(file, log) {
  await writeAtomicTextFile(
    file,
    JSON.stringify({ ...log, undoneAt: new Date().toISOString() }, null, 2)
  )
}

/** 最近的日志摘要（新到旧）。 */
export async function listOpLogs(dir, limit = 50) {
  let files = []
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const sorted = files
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
  // 分批并行读取（串行 readFile 在日志多/机械盘上会阻塞 IPC 数秒）
  const logs = []
  const READ_BATCH = 8
  for (let i = 0; i < sorted.length; i += READ_BATCH) {
    const batch = sorted.slice(i, i + READ_BATCH)
    const parsed = await Promise.all(
      batch.map(async (file) => {
        try {
          return { file, raw: JSON.parse(await readFile(join(dir, file), 'utf8')) }
        } catch {
          return null // 损坏日志跳过
        }
      })
    )
    for (const entry of parsed) {
      if (!entry) continue
      const { file, raw } = entry
      logs.push({
        file: join(dir, file),
        module: raw.module ?? '?',
        finishedAt: raw.finishedAt ?? '',
        summary: raw.summary ?? '',
        undone: Boolean(raw.undoneAt),
        undoable:
          !raw.undoneAt &&
          (raw.module === 'rename'
            ? (raw.report?.items?.length ?? 0) > 0
            : raw.module === 'nfo'
              ? (raw.report?.archived?.length ?? 0) > 0
              : false)
      })
    }
  }
  return logs
}
