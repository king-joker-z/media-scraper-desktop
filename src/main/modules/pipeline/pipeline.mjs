/**
 * 流水线执行引擎：按预设步骤顺序执行各模块，汇总报告。
 *
 * 自动化策略（无需人工干预）：
 * - clean：扫描后自动执行（无 pendingPick 时直接清理，有 pendingPick 时跳过该步骤并警告）
 * - nfo：扫描计划后自动执行（actorName 取工作区目录名）
 * - dedupe：扫描后自动删除完全重复项（保留质量最高的一份）
 * - health：只读体检，直接执行
 *
 * 每个步骤的执行结果汇总为 PipelineReport，步骤失败不阻断后续步骤。
 */

import { basename, dirname, join } from 'node:path'
import {
  applyScanMutations,
  createScanPlan,
  pinScanRecords,
  unpinScanRecords
} from '../../core/scanner.mjs'
import { executeCleanPlan } from '../clean/execute.mjs'
import { createNfoPlan, executeNfoPlan } from '../nfo/nfo.mjs'
import { findDuplicates } from '../dedupe/dedupe.mjs'
import { healthScan } from '../health/health.mjs'
import { resolveFfmpegPath } from '../../core/frames.mjs'
import { resolveFfprobePath } from '../../core/probe.mjs'
import { permanentDelete } from '../../core/fs-ops.mjs'

// 流水线内部任务 ID：毫秒 + 自增序号防同毫秒碰撞
let stepSeq = 0
const stepTaskId = (prefix) => `${prefix}-${Date.now()}-${(stepSeq += 1)}`

/**
 * 执行单个流水线步骤。
 * @param {string} root 工作区根目录
 * @param {string} module 模块 ID
 * @param {object} opts { taskCenter, concurrency, signal, deleteFn }
 * @returns {Promise<{ summary: string, mutations?: object }>}
 *   mutations 为本步骤对文件系统的已知变更（相对路径），供流水线增量合并扫描记录
 */
async function runStep(root, module, { taskCenter, concurrency, deleteFn = permanentDelete }) {
  const taskId = stepTaskId(`pipeline-${module}`)

  switch (module) {
    case 'clean': {
      const plan = await createScanPlan(root)
      if (plan.pendingPick.length > 0) {
        return {
          summary: `跳过：${plan.pendingPick.length} 个视频需要人工选择 poster，无法自动清理`
        }
      }
      const report = await executeCleanPlan(plan, {
        taskCenter,
        taskId,
        concurrency,
        picks: {},
        deleteFn
      })
      // renamed/converted 的 to 是同目录新基名；moved 的 to 是根目录新基名
      const moved = [
        ...report.renamed.map((x) => ({ from: x.from, to: join(dirname(x.from), x.to) })),
        ...report.converted.map((x) => ({ from: x.from, to: join(dirname(x.from), x.to) })),
        ...report.moved.map((x) => ({ from: x.from, to: x.to }))
      ]
      // 转码会删除原图（converted 的 from 已不在磁盘）
      const deleted = [...report.deleted, ...report.converted.map((x) => x.from)]
      return {
        summary: `删除 ${report.deletedCount} 项，上移 ${report.moved.length} 项，转码 ${report.converted.length} 项`,
        mutations: { deleted, moved }
      }
    }

    case 'nfo': {
      const plan = await createNfoPlan(root)
      if (plan.items.length === 0) {
        return { summary: '无需归档：未发现视频文件' }
      }
      const actorName = basename(root)
      const report = await executeNfoPlan(root, plan.items, actorName, {
        taskCenter,
        taskId,
        concurrency
      })
      // 归档 = 视频/poster 移入子目录 + 新建 .nfo
      const moved = []
      const created = []
      for (const item of report.archived) {
        moved.push({ from: item.videoRel, to: join(item.targetDir, item.videoName) })
        if (item.posterRel && item.posterName) {
          moved.push({ from: item.posterRel, to: join(item.targetDir, item.posterName) })
        }
        created.push(join(item.targetDir, item.nfoName))
      }
      return {
        summary: `归档 ${report.archivedCount} 个视频，失败 ${report.failed.length} 个`,
        mutations: { moved, created }
      }
    }

    case 'dedupe': {
      const result = await findDuplicates(root, {
        taskCenter,
        taskId,
        concurrency,
        ffprobePath: resolveFfprobePath()
      })
      if (result.exact.length === 0) {
        return { summary: '未发现完全重复项' }
      }
      // 自动删除完全重复项（每组保留 keepRel，删除其余）
      const toDelete = []
      for (const group of result.exact) {
        for (const item of group.items) {
          if (item.relativePath !== group.keepRel) {
            toDelete.push(item.relativePath)
          }
        }
      }
      if (toDelete.length === 0) {
        return { summary: '未发现需要删除的重复项' }
      }
      const deleteTaskId = stepTaskId('pipeline-dedupe-del')
      const deleteResult = await taskCenter.run({
        taskId: deleteTaskId,
        label: '删除重复视频',
        items: toDelete,
        concurrency,
        worker: async (relativePath, signal) => {
          if (signal?.aborted) throw new Error('已取消')
          await deleteFn(join(root, relativePath))
        }
      })
      const deleted = deleteResult.completed
      const failed = deleteResult.results.filter((e) => !e.ok && !e.cancelled).length
      // 仅收集实际删除成功的路径
      const deletedPaths = toDelete.filter((_, index) => deleteResult.results[index]?.ok)
      return {
        summary: `发现 ${result.exact.length} 组重复，删除 ${deleted} 个${failed > 0 ? `，失败 ${failed} 个` : ''}`,
        mutations: { deleted: deletedPaths }
      }
    }

    case 'health': {
      const report = await healthScan(root, {
        taskCenter,
        taskId,
        concurrency,
        ffmpegPath: resolveFfmpegPath()
      })
      const parts = [`检查 ${report.checked}/${report.total} 个视频`]
      if (report.corrupted.length > 0) parts.push(`损坏 ${report.corrupted.length} 个`)
      if (report.missingPoster.length > 0) parts.push(`缺封面 ${report.missingPoster.length} 个`)
      if (report.missingNfo.length > 0) parts.push(`缺 NFO ${report.missingNfo.length} 个`)
      if (report.corrupted.length === 0) parts.push('全部健康')
      return { summary: parts.join('，') }
    }

    default:
      throw new Error(`未知模块：${module}`)
  }
}

/**
 * 执行流水线。
 * @param {string} root 工作区根目录
 * @param {Array} steps PipelineStep[]
 * @param {object} opts { taskCenter, concurrency, onStepStart, onStepDone, signal }
 * @returns {Promise<import('../../../shared/types').PipelineReport>}
 */
export async function runPipeline(
  root,
  steps,
  { taskCenter, concurrency = 5, onStepStart, onStepDone, signal, deleteFn }
) {
  const startedAt = Date.now()
  const results = []
  const activeSteps = steps.filter((s) => s.enabled)

  // 预扫描一次并钉住记录：各步骤的 createScanPlan 命中钉住记录零遍历重建；
  // 步骤的已知文件变更（删除/移动/新建）经 applyScanMutations 增量合并，
  // 四步流水线只付出一次全量遍历（原先逐步各一次）。
  await createScanPlan(root)
  pinScanRecords(root)
  try {
    for (const step of activeSteps) {
      if (signal?.aborted) {
        return {
          cancelled: true,
          results,
          totalDurationMs: Date.now() - startedAt
        }
      }

      onStepStart?.(step)
      const stepStart = Date.now()
      try {
        const { summary, mutations } = await runStep(root, step.module, {
          taskCenter,
          concurrency,
          deleteFn
        })
        if (mutations) await applyScanMutations(root, mutations)
        const result = {
          module: step.module,
          success: true,
          durationMs: Date.now() - stepStart,
          summary
        }
        results.push(result)
        onStepDone?.(result)
      } catch (error) {
        const result = {
          module: step.module,
          success: false,
          durationMs: Date.now() - stepStart,
          summary: '执行失败',
          error: error instanceof Error ? error.message : String(error)
        }
        results.push(result)
        onStepDone?.(result)
        // 步骤失败不阻断后续步骤
      }
    }
  } finally {
    unpinScanRecords()
  }

  return {
    cancelled: false,
    results,
    totalDurationMs: Date.now() - startedAt
  }
}
