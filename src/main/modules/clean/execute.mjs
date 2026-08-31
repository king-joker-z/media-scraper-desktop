import { basename, dirname, join } from 'node:path'
import {
  ensureUniquePath,
  moveWithCollision,
  permanentDelete,
  removeEmptyDirs,
  renameWithCollision
} from '../../core/fs-ops.mjs'
import { convertToJpg, isJpegName } from '../../core/image.mjs'
import { posterFinalName } from '../../core/scanner.mjs'
import { collectFailures, finishReport } from '../../core/task-report.mjs'
import { resolveInsideRoot } from '../../core/path-guard.mjs'

/**
 * 执行清理计划（冻结稿 §3 执行顺序）：
 * 校验人工选择 → 永久删除 → poster 标准化（改名/转 JPG）→ 上移 → 删空目录 → 报告。
 *
 * @param {object} plan createScanPlan 产物
 * @param {object} options
 * @param {Record<string, string>} [options.picks] pendingPick 人工选择：视频 relativePath -> 图片 relativePath
 * @param {object} options.taskCenter 任务中心实例
 * @param {string} options.taskId 任务 id（取消用）
 * @param {number} [options.concurrency] 并发数
 * @param {(target: string) => Promise<void>} [options.deleteFn] 删除实现（默认永久删除；可按设置注入回收站删除）
 */
/**
 * 仅解散文件夹：保留全部可见文件原样，将子目录内容上移到工作区根；
 * 不删除、不转码、不改 poster。重名仍通过 moveWithCollision 追加序号，隐藏项保持不动。
 */
export async function executeDissolveFolders(
  plan,
  { taskCenter, taskId, concurrency = 5, signal, onMoveProgress } = {}
) {
  const startedAt = Date.now()
  const report = {
    taskId,
    cancelled: false,
    deletedCount: 0,
    deletedBytes: 0,
    converted: [],
    renamed: [],
    moved: [],
    removedDirs: [],
    failed: [],
    durationMs: 0
  }
  const files = new Map()
  for (const item of [...plan.keep, ...plan.deleteItems]) files.set(item.relativePath, item)
  for (const pending of plan.pendingPick) {
    for (const relativePath of pending.candidates) {
      if (!files.has(relativePath)) files.set(relativePath, findRecord(plan, relativePath))
    }
  }
  const toMove = [...files.values()].filter((item) => item.dir !== '.')
  const result = await taskCenter.run({
    taskId,
    label: '解散文件夹',
    items: toMove,
    concurrency,
    signal,
    worker: async (item, workerSignal) => {
      const sourcePath = itemPath(plan.root, item.relativePath)
      const finalPath = await moveWithCollision(sourcePath, plan.root, {
        signal: workerSignal,
        onProgress: (copied, total) => {
          if (total > 1024 * 1024)
            onMoveProgress?.(`${item.relativePath} ${Math.round((copied / total) * 100)}%`)
        }
      })
      report.moved.push({ from: item.relativePath, to: basename(finalPath) })
    }
  })
  collectFailures(report, result, toMove, 'relativePath')
  report.removedDirs = await removeEmptyDirs(plan.root)
  return finishReport(report, startedAt, result.cancelled)
}

export async function executeCleanPlan(
  plan,
  { picks = {}, taskCenter, taskId, concurrency = 5, signal, onMoveProgress, deleteFn } = {}
) {
  const doDelete = deleteFn ?? permanentDelete
  const startedAt = Date.now()
  const report = {
    taskId,
    cancelled: false,
    deletedCount: 0,
    deletedBytes: 0,
    // 已删除项的相对路径（流水线增量合并扫描记录用）
    deleted: [],
    converted: [],
    renamed: [],
    moved: [],
    removedDirs: [],
    failed: [],
    durationMs: 0
  }

  // ---- 0. 合并人工选择：pendingPick 必须全部有选择，否则拒绝执行（不写任何文件） ----
  const keep = plan.keep.map((item) => ({ ...item }))
  const deleteItems = plan.deleteItems.map((item) => ({ ...item }))
  for (const pending of plan.pendingPick) {
    const chosen = picks[pending.video]
    if (!chosen || !pending.candidates.includes(chosen)) {
      throw new Error(`视频 ${pending.video} 尚未选择 poster，已取消执行`)
    }
    for (const candidate of pending.candidates) {
      const record = findRecord(plan, candidate)
      if (candidate === chosen) {
        keep.push({
          ...record,
          posterFor: pending.video,
          finalName: posterFinalName(pending.video)
        })
      } else {
        deleteItems.push({ ...record, reason: '未被选为 poster 的候选图' })
      }
    }
  }

  const runPhase = (label, items, worker) =>
    taskCenter.run({ taskId, label, items, worker, concurrency, signal })

  // ---- 1. 删除清理项（默认进回收站，可在设置改永久删除；最先执行，释放根目录占位名） ----
  const deleteResult = await runPhase('删除清理项', deleteItems, async (item, signal) => {
    if (signal?.aborted) throw new Error('已取消')
    await doDelete(itemPath(plan.root, item.relativePath))
    report.deletedCount += 1
    report.deletedBytes += item.size
    report.deleted.push(item.relativePath)
  })
  collectFailures(report, deleteResult, deleteItems, 'relativePath')
  if (deleteResult.cancelled) return finishReport(report, startedAt, true)

  // ---- 2. poster 标准化：jpg 直接改名，其余格式转 JPG 后删原图 ----
  const posters = keep.filter((item) => item.posterFor && item.finalName)
  const standardizeResult = await runPhase('标准化 poster', posters, async (item) => {
    const sourcePath = itemPath(plan.root, item.relativePath)
    if (item.name === item.finalName) return
    const dir = dirname(sourcePath)
    if (isJpegName(item.name)) {
      const finalPath = await renameWithCollision(sourcePath, item.finalName)
      if (finalPath !== sourcePath) {
        report.renamed.push({ from: item.relativePath, to: basename(finalPath) })
        item.path = finalPath
        item.relativePath = join(dirname(item.relativePath), basename(finalPath))
        item.name = basename(finalPath)
      }
    } else {
      const desired = join(dir, item.finalName)
      const target = desired === sourcePath ? desired : await ensureUniquePath(desired)
      await convertToJpg(sourcePath, target)
      await permanentDelete(sourcePath)
      report.converted.push({ from: item.relativePath, to: basename(target) })
      item.path = target
      item.relativePath = join(dirname(item.relativePath), basename(target))
      item.name = basename(target)
    }
  })
  collectFailures(report, standardizeResult, posters, 'relativePath')
  if (standardizeResult.cancelled) return finishReport(report, startedAt, true)

  // ---- 3. 上移子目录保留项到工作区根（重名自动 (n)） ----
  const toMove = keep.filter((item) => item.dir !== '.')
  const moveResult = await runPhase('上移保留文件', toMove, async (item, signal) => {
    const finalPath = await moveWithCollision(itemPath(plan.root, item.relativePath), plan.root, {
      onProgress: (copied, total) => {
        if (total > 1024 * 1024) {
          onMoveProgress?.(`${item.relativePath} ${Math.round((copied / total) * 100)}%`)
        }
      },
      signal
    })
    report.moved.push({ from: item.relativePath, to: basename(finalPath) })
  })
  collectFailures(report, moveResult, toMove, 'relativePath')
  if (moveResult.cancelled) return finishReport(report, startedAt, true)

  // ---- 4. 删除已清空且不含隐藏内容的子目录 ----
  report.removedDirs = await removeEmptyDirs(plan.root)

  return finishReport(report, startedAt, false)
}

function findRecord(plan, relativePath) {
  // pendingPick 的候选图不在 keep/delete 中，需从扫描记录恢复最小字段
  return {
    path: join(plan.root, relativePath),
    relativePath,
    dir: dirname(relativePath),
    name: basename(relativePath),
    kind: 'image',
    size: 0
  }
}

/** 执行层不信任 IPC 传入的绝对路径，始终由已验证的根与相对路径重建来源。 */
function itemPath(root, relativePath) {
  return resolveInsideRoot(root, relativePath)
}
