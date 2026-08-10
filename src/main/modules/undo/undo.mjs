import { dirname, join } from 'node:path'
import {
  ensureUniquePath,
  moveFile,
  pathExists,
  permanentDelete,
  removeEmptyDirs
} from '../../core/fs-ops.mjs'
import { markOpLogUndone, readOpLog } from '../../core/op-log.mjs'

/**
 * 一键撤销（F2）：按操作日志反向恢复文件位置。
 *
 * 支持模块：
 * - rename：report.items [{from: 原相对路径, to: 新文件名}] → 新文件移回原相对路径
 * - nfo：report.archived [{targetDir, videoName, posterName, nfoName}] →
 *   视频/poster 移回工作区根，删除生成的 NFO，清理空目录
 *
 * 删除类日志（clean/dedupe/merge-delete-sources）不可撤销——删除已进回收站（F1），
 * 需要恢复时从系统回收站还原。
 *
 * 撤销全部成功后回写日志 undoneAt 标记，防止重复撤销造成混乱。
 */
export async function undoOpLog(file, { taskCenter, taskId, concurrency = 5 } = {}) {
  const log = await readOpLog(file)
  if (!log) throw new Error('日志不存在或已损坏')
  if (log.undoneAt) throw new Error('该日志已撤销过，不能重复撤销')
  const root = log.root
  if (!root) throw new Error('日志缺少工作区信息，无法撤销')

  const report = { module: log.module, undone: 0, skipped: 0, failed: [] }

  if (log.module === 'rename') {
    const items = Array.isArray(log.report?.items) ? log.report.items : []
    if (items.length === 0) throw new Error('该日志没有可撤销的改名记录')
    // 逆序回退：链式改名（A→B、B→C）时先恢复后面的，避免相互覆盖
    const ops = items
      .slice()
      .reverse()
      .map((item) => ({
        target: item.from,
        current: join(root, dirname(item.from), item.to),
        restoreTo: join(root, item.from)
      }))
    await runUndoOps(ops, report, { taskCenter, taskId, concurrency })
  } else if (log.module === 'nfo') {
    const archived = Array.isArray(log.report?.archived) ? log.report.archived : []
    if (archived.length === 0) throw new Error('该日志没有可撤销的归档记录')
    const ops = []
    for (const entry of archived) {
      const dir = join(root, entry.targetDir)
      ops.push({
        target: `${entry.targetDir}/${entry.videoName}`,
        current: join(dir, entry.videoName),
        // 优先恢复原始相对路径；旧日志没有该字段时回退到根目录+落位名
        restoreTo: join(root, entry.videoRel ?? entry.videoName)
      })
      if (entry.posterName) {
        ops.push({
          target: `${entry.targetDir}/${entry.posterName}`,
          current: join(dir, entry.posterName),
          restoreTo: join(root, entry.posterRel ?? entry.posterName)
        })
      }
    }
    await runUndoOps(ops, report, { taskCenter, taskId, concurrency })
    // 删除生成的 NFO（本就是程序产物，直接删除）并清理空目标目录
    for (const entry of archived) {
      await permanentDelete(join(root, entry.targetDir, entry.nfoName)).catch(() => {})
    }
    await removeEmptyDirs(root).catch(() => [])
  } else {
    throw new Error(`「${log.module}」类型的日志不支持撤销（删除类请从系统回收站恢复）`)
  }

  if (report.failed.length === 0) {
    await markOpLogUndone(file, log).catch(() => {})
  }
  return report
}

/** 逐条反向移动：已消失的条目记为跳过，失败的收集进报告。 */
async function runUndoOps(ops, report, { taskCenter, taskId, concurrency }) {
  const undoOne = async (op) => {
    if (!(await pathExists(op.current))) return { skipped: true }
    // 恢复到原始路径（原位置被占用时自动加 (n)，绝不覆盖）
    const target = await ensureUniquePath(op.restoreTo)
    await moveFile(op.current, target)
    return { skipped: false }
  }
  if (taskCenter && taskId) {
    const result = await taskCenter.run({
      taskId,
      label: '撤销操作',
      items: ops,
      concurrency,
      worker: undoOne
    })
    result.results.forEach((entry, index) => {
      if (entry?.ok) {
        if (entry.value?.skipped) report.skipped += 1
        else report.undone += 1
      } else if (!entry?.cancelled) {
        report.failed.push({ target: ops[index].target, error: entry?.error ?? '未知错误' })
      }
    })
    return
  }
  for (const op of ops) {
    try {
      const { skipped } = await undoOne(op)
      if (skipped) report.skipped += 1
      else report.undone += 1
    } catch (error) {
      report.failed.push({
        target: op.target,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
