import { readdir, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { writeAtomicTextFile } from './fs-ops.mjs'

export const OP_LOG_KEEP = 100

export async function pruneOpLogs(dir, keep = OP_LOG_KEEP) {
  let files = []
  try {
    files = await readdir(dir)
  } catch {
    return 0
  }
  const stale = files
    .filter((file) => file.endsWith('.json'))
    .sort()
    .reverse()
    .slice(Math.max(0, keep))
  for (const file of stale) await rm(join(dir, file), { force: true }).catch(() => {})
  return stale.length
}

export async function writeOpLog(dir, module, payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${stamp}-${module}-${randomUUID()}.json`)
  await writeAtomicTextFile(
    file,
    JSON.stringify({ module, finishedAt: new Date().toISOString(), ...payload }, null, 2)
  )
  await pruneOpLogs(dir).catch(() => 0)
  return file
}

export async function readOpLog(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** 在原日志持久记录每次撤销尝试；仅无失败时标记为已撤销，保留部分成功的真实结果。 */
export async function markOpLogUndoAttempt(file, log, report, completed) {
  const attempt = { attemptedAt: new Date().toISOString(), ...report }
  await writeAtomicTextFile(
    file,
    JSON.stringify(
      { ...log, lastUndoAttempt: attempt, ...(completed ? { undoneAt: attempt.attemptedAt } : {}) },
      null,
      2
    )
  )
}

const undoable = (raw) =>
  !raw.undoneAt &&
  ((raw.module === 'rename' && (raw.report?.items?.length ?? 0) > 0) ||
    (raw.module === 'nfo' && (raw.report?.archived?.length ?? 0) > 0))
const categoryOf = (module) =>
  module.includes('delete') || module === 'clean'
    ? 'delete'
    : module.includes('rename')
      ? 'rename'
      : module === 'nfo'
        ? 'archive'
        : module.includes('merge')
          ? 'merge'
          : 'other'

/** 将绝对路径严格相对化到日志工作区；根外、Windows 盘符与 UNC 一律不泄漏。 */
const safePath = (value, root) => {
  if (typeof value !== 'string' || !value) return '未知项'
  const windowsAbsolute =
    win32.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)
  if (!isAbsolute(value) && !windowsAbsolute) return value.replace(/\\/g, '/')
  if (!root) return '工作区外路径'
  const rootWindows = win32.isAbsolute(root) || /^[a-zA-Z]:[\\/]/.test(root) || /^\\\\/.test(root)
  if (windowsAbsolute || rootWindows) {
    const diff = win32.relative(root.replace(/\//g, '\\'), value.replace(/\//g, '\\'))
    return diff && !diff.startsWith('..\\') && diff !== '..' && !win32.isAbsolute(diff)
      ? diff.replace(/\\/g, '/')
      : '工作区外路径'
  }
  const diff = relative(resolve(root), resolve(value))
  return diff && !diff.startsWith('../') && diff !== '..' && !isAbsolute(diff)
    ? diff
    : '工作区外路径'
}

const failuresOf = (raw) =>
  Array.isArray(raw.report?.failed)
    ? raw.report.failed
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          target: safePath(String(item.target ?? ''), raw.root),
          error: String(item.error ?? '未知错误')
        }))
    : []

const countOf = (raw, failures) => {
  const report = raw.report ?? {}
  const affected =
    report.items?.length ??
    report.archived?.length ??
    raw.items?.length ??
    report.deletedCount ??
    report.renamedCount ??
    report.archivedCount ??
    report.merged?.length ??
    0
  const success =
    report.deletedCount ??
    report.renamedCount ??
    report.archivedCount ??
    report.undone ??
    report.merged?.length ??
    0
  return { affected: Number(affected) || 0, success: Number(success) || 0, failed: failures.length }
}

const summaryOf = (file, raw) => {
  const failures = failuresOf(raw)
  const counts = countOf(raw, failures)
  return {
    file,
    module: raw.module ?? '?',
    category: categoryOf(raw.module ?? '?'),
    finishedAt: raw.finishedAt ?? '',
    summary: raw.summary ?? '旧格式记录，详情有限',
    affectedCount: counts.affected,
    successCount: counts.success,
    failedCount: counts.failed,
    undone: Boolean(raw.undoneAt),
    undoable: undoable(raw)
  }
}

const detailItemsOf = (raw) => {
  const items = []
  if (Array.isArray(raw.report?.items))
    for (const item of raw.report.items)
      items.push({
        before: safePath(item.from, raw.root),
        after: safePath(item.to, raw.root),
        status: 'done'
      })
  else if (Array.isArray(raw.report?.archived))
    for (const item of raw.report.archived)
      items.push({
        before: safePath(item.videoRel ?? item.videoName, raw.root),
        after: safePath(item.targetDir, raw.root),
        status: 'done'
      })
  else if (Array.isArray(raw.items))
    for (const item of raw.items)
      items.push({
        target: safePath(
          typeof item === 'string' ? item : (item.videoRel ?? item.relDir),
          raw.root
        ),
        status: 'done'
      })
  for (const failure of failuresOf(raw))
    items.push({ target: failure.target, status: 'failed', error: failure.error })
  return items.filter((item) => item.before || item.after || item.target)
}

/** 读取单份脱敏详情；file 只能是 op-log 目录内的日志文件名。 */
export async function getOpLogDetail(dir, file) {
  if (typeof file !== 'string' || basename(file) !== file || !file.endsWith('.json')) return null
  const raw = await readOpLog(join(dir, file))
  if (!raw) return null
  const summary = summaryOf(file, raw)
  return {
    ...summary,
    workspace: typeof raw.root === 'string' ? basename(raw.root) : undefined,
    legacy: !raw.summary || !raw.report,
    items: detailItemsOf(raw),
    failures: failuresOf(raw),
    undoneAt: raw.undoneAt,
    undoReport: raw.lastUndoAttempt
  }
}

export async function listOpLogs(dir, limit = 50) {
  let files = []
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const sorted = files
    .filter((file) => file.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
  const logs = []
  for (let index = 0; index < sorted.length; index += 8) {
    const parsed = await Promise.all(
      sorted.slice(index, index + 8).map(async (file) => {
        const raw = await readOpLog(join(dir, file))
        return raw ? { file, raw } : null
      })
    )
    for (const entry of parsed) if (entry) logs.push(summaryOf(entry.file, entry.raw))
  }
  return logs
}
