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
export async function executeCleanPlan(
  plan,
  { picks = {}, taskCenter, taskId, concurrency = 5, onMoveProgress, deleteFn } = {}
) {
  const doDelete = deleteFn ?? permanentDelete
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
    taskCenter.run({ taskId, label, items, worker, concurrency })

  // ---- 1. 删除清理项（默认进回收站，可在设置改永久删除；最先执行，释放根目录占位名） ----
  const deleteResult = await runPhase('删除清理项', deleteItems, async (item) => {
    await doDelete(item.path)
    report.deletedCount += 1
    report.deletedBytes += item.size
  })
  collectFailures(report, deleteResult, deleteItems, 'relativePath')
  if (deleteResult.cancelled) return finishReport(report, startedAt, true)

  // ---- 2. poster 标准化：jpg 直接改名，其余格式转 JPG 后删原图 ----
  const posters = keep.filter((item) => item.posterFor && item.finalName)
  const standardizeResult = await runPhase('标准化 poster', posters, async (item) => {
    if (item.name === item.finalName) return
    const dir = dirname(item.path)
    if (isJpegName(item.name)) {
      const finalPath = await renameWithCollision(item.path, item.finalName)
      if (finalPath !== item.path) {
        report.renamed.push({ from: item.relativePath, to: basename(finalPath) })
        item.path = finalPath
        item.name = basename(finalPath)
      }
    } else {
      const desired = join(dir, item.finalName)
      const target = desired === item.path ? desired : await ensureUniquePath(desired)
      await convertToJpg(item.path, target)
      await permanentDelete(item.path)
      report.converted.push({ from: item.relativePath, to: basename(target) })
      item.path = target
      item.name = basename(target)
    }
  })
  collectFailures(report, standardizeResult, posters, 'relativePath')
  if (standardizeResult.cancelled) return finishReport(report, startedAt, true)

  // ---- 3. 上移子目录保留项到工作区根（重名自动 (n)） ----
  const toMove = keep.filter((item) => item.dir !== '.')
  const moveResult = await runPhase('上移保留文件', toMove, async (item, signal) => {
    const finalPath = await moveWithCollision(item.path, plan.root, {
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
