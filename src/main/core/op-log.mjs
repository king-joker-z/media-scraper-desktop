import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeTextFile } from './fs-ops.mjs'

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
  const file = join(dir, `${stamp}-${module}.json`)
  await writeTextFile(
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
  await writeTextFile(file, JSON.stringify({ ...log, undoneAt: new Date().toISOString() }, null, 2))
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
  const logs = []
  for (const file of sorted) {
    try {
      const raw = JSON.parse(await readFile(join(dir, file), 'utf8'))
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
    } catch {
      // 损坏日志跳过
    }
  }
  return logs
}
