import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  directRename,
  ensureUniquePath,
  moveFile,
  pathExists,
  permanentDelete,
  removeEmptyDirs
} from '../../core/fs-ops.mjs'
import { markOpLogUndoAttempt, readOpLog } from '../../core/op-log.mjs'

/** 将日志还原为反向移动操作；只供预检和执行共用，避免两端规则漂移。 */
function createUndoOps(log) {
  const root = log.root
  if (!root) throw new Error('日志缺少工作区信息，无法撤销')
  if (log.module === 'rename') {
    const items = Array.isArray(log.report?.items) ? log.report.items : []
    if (items.length === 0) throw new Error('该日志没有可撤销的改名记录')
    return items.map((item) => ({
      target: item.from,
      current: join(root, dirname(item.from), item.to),
      restoreTo: join(root, item.from)
    }))
  }
  if (log.module === 'nfo') {
    const archived = Array.isArray(log.report?.archived) ? log.report.archived : []
    if (archived.length === 0) throw new Error('该日志没有可撤销的归档记录')
    return archived.flatMap((entry, entryIndex) => {
      const dir = join(root, entry.targetDir)
      const ops = [
        {
          entryIndex,
          kind: 'video',
          target: `${entry.targetDir}/${entry.videoName}`,
          current: join(dir, entry.videoName),
          restoreTo: join(root, entry.videoRel ?? entry.videoName)
        }
      ]
      if (entry.posterName) {
        ops.push({
          entryIndex,
          kind: 'poster',
          target: `${entry.targetDir}/${entry.posterName}`,
          current: join(dir, entry.posterName),
          restoreTo: join(root, entry.posterRel ?? entry.posterName)
        })
      }
      return ops
    })
  }
  throw new Error(`「${log.module}」类型的日志不支持撤销（删除类请从系统回收站恢复）`)
}

/** 撤销前只读检查。执行阶段仍会再次检查，绝不覆盖外部新文件。 */
export async function preflightUndoOpLog(file) {
  const log = await readOpLog(file)
  if (!log) return unavailablePreflight('?', '日志不存在或已损坏')
  if (log.undoneAt) return unavailablePreflight(log.module, '该日志已撤销过')
  let ops
  try {
    ops = createUndoOps(log)
  } catch (error) {
    return unavailablePreflight(
      log.module ?? '?',
      error instanceof Error ? error.message : String(error)
    )
  }
  const currentPaths = new Set(ops.map((op) => op.current))
  const items = await Promise.all(
    ops.map(async (op) => {
      if (!(await pathExists(op.current))) {
        return {
          target: op.target,
          status: 'missing',
          message: '当前文件已被外部移动或删除，将跳过'
        }
      }
      // 目标若正由本批其他源占用，会经两段式事务腾空，不是外部冲突。
      if (!currentPaths.has(op.restoreTo) && (await pathExists(op.restoreTo))) {
        return {
          target: op.target,
          status: 'collision',
          message: '原位置已有外部文件，将以唯一名称恢复'
        }
      }
      return { target: op.target, status: 'ready' }
    })
  )
  const ready = items.filter((item) => item.status === 'ready').length
  return {
    module: log.module,
    canUndo: ready > 0,
    reason: ready === 0 ? '没有可恢复的文件' : undefined,
    ready,
    skipped: items.filter((item) => item.status === 'missing').length,
    collisions: items.filter((item) => item.status === 'collision').length,
    items
  }
}

const unavailablePreflight = (module, reason) => ({
  module,
  canUndo: false,
  reason,
  ready: 0,
  skipped: 0,
  collisions: 0,
  items: []
})

/** 一键撤销：按操作日志反向恢复文件位置。 */
export async function undoOpLog(file) {
  const log = await readOpLog(file)
  if (!log) throw new Error('日志不存在或已损坏')
  if (log.undoneAt) throw new Error('该日志已撤销过，不能重复撤销')
  const ops = createUndoOps(log)
  const report = { module: log.module, undone: 0, skipped: 0, failed: [], nfoRetained: [] }

  if (log.module === 'rename') await undoRenameTransaction(ops, report)
  else await undoNfoArchive(log, ops, report)

  // 无论完全成功与否都留存最近一次尝试；完整处理后才阻止重复撤销。
  await markOpLogUndoAttempt(file, log, report, report.failed.length === 0).catch(() => {})
  return report
}

/**
 * 两段式反向改名：先把本批现文件全部移到同目录唯一临时名，再统一落回原名。
 * 这样 A↔B、A→B→C→A 与带 poster 的关联改名均不会产生 (1) 或内容错配。
 */
async function undoRenameTransaction(ops, report) {
  const staged = []
  const sourcePaths = new Set(ops.map((op) => op.current))
  const stamp = randomUUID()

  for (const [index, op] of ops.entries()) {
    if (!(await pathExists(op.current))) {
      report.skipped += 1
      continue
    }
    const temp = join(dirname(op.current), `.msd-undo-${stamp}-${index}${extname(op.current)}`)
    try {
      await directRename(op.current, temp)
      staged.push({ ...op, temp })
    } catch (error) {
      report.failed.push({ target: op.target, error: messageOf(error) })
    }
  }

  const stagedSources = new Set(staged.map((op) => op.current))
  for (const op of staged) {
    try {
      // 本批已成功腾空的目标必须精确落位；仅未参与/阶段一失败的源才视为外部冲突。
      const target =
        sourcePaths.has(op.restoreTo) && stagedSources.has(op.restoreTo)
          ? op.restoreTo
          : await ensureUniquePath(op.restoreTo)
      await moveFile(op.temp, target)
      report.undone += 1
    } catch (error) {
      report.failed.push({ target: op.target, error: messageOf(error) })
    }
  }
}

/** NFO 归档按条目处理，只有整组素材已恢复时才删除程序生成的 NFO。 */
async function undoNfoArchive(log, ops, report) {
  const archived = log.report.archived
  for (const [entryIndex, entry] of archived.entries()) {
    const entryOps = ops.filter((op) => op.entryIndex === entryIndex)
    const statuses = {}
    for (const op of entryOps) statuses[op.kind] = await undoOne(op, report)

    const videoRestored = statuses.video === 'undone'
    const posterRestored = !entry.posterName || statuses.poster === 'undone'
    if (videoRestored && posterRestored) {
      await permanentDelete(join(log.root, entry.targetDir, entry.nfoName)).catch((error) => {
        report.failed.push({
          target: `${entry.targetDir}/${entry.nfoName}`,
          error: messageOf(error)
        })
      })
    } else {
      report.nfoRetained.push({
        target: `${entry.targetDir}/${entry.nfoName}`,
        reason: '关联视频或封面未完整恢复，已保留 NFO 以避免丢失元数据'
      })
    }
  }
  await removeEmptyDirs(log.root).catch(() => [])
}

async function undoOne(op, report) {
  if (!(await pathExists(op.current))) {
    report.skipped += 1
    return 'skipped'
  }
  try {
    const target = await ensureUniquePath(op.restoreTo)
    await moveFile(op.current, target)
    report.undone += 1
    return 'undone'
  } catch (error) {
    report.failed.push({ target: op.target, error: messageOf(error) })
    return 'failed'
  }
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))
