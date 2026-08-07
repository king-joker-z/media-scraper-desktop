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

import { basename } from 'node:path'
import { join } from 'node:path'
import { createScanPlan } from '../../core/scanner.mjs'
import { executeCleanPlan } from '../clean/execute.mjs'
import { createNfoPlan, executeNfoPlan } from '../nfo/nfo.mjs'
import { findDuplicates } from '../dedupe/dedupe.mjs'
import { healthScan } from '../health/health.mjs'
import { resolveFfmpegPath } from '../../core/frames.mjs'
import { resolveFfprobePath } from '../../core/probe.mjs'
import { permanentDelete } from '../../core/fs-ops.mjs'

/**
 * 执行单个流水线步骤。
 * @param {string} root 工作区根目录
 * @param {string} module 模块 ID
 * @param {object} opts { taskCenter, concurrency, signal }
 * @returns {Promise<{ summary: string }>}
 */
async function runStep(root, module, { taskCenter, concurrency, signal }) {
  const taskId = `pipeline-${module}-${Date.now()}`

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
        picks: {}
      })
      return {
        summary: `删除 ${report.deletedCount} 项，上移 ${report.moved.length} 项，转码 ${report.converted.length} 项`
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
      return { summary: `归档 ${report.archivedCount} 个视频，失败 ${report.failed.length} 个` }
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
      const deleteTaskId = `pipeline-dedupe-del-${Date.now()}`
      const deleteResult = await taskCenter.run({
        taskId: deleteTaskId,
        label: '删除重复视频',
        items: toDelete,
        concurrency,
        worker: async (relativePath) => {
          await permanentDelete(join(root, relativePath))
        }
      })
      const deleted = deleteResult.completed
      const failed = deleteResult.results.filter((e) => !e.ok && !e.cancelled).length
      return {
        summary: `发现 ${result.exact.length} 组重复，删除 ${deleted} 个${failed > 0 ? `，失败 ${failed} 个` : ''}`
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
  { taskCenter, concurrency = 5, onStepStart, onStepDone, signal }
) {
  const startedAt = Date.now()
  const results = []
  const activeSteps = steps.filter((s) => s.enabled)

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
      const { summary } = await runStep(root, step.module, { taskCenter, concurrency, signal })
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

  return {
    cancelled: false,
    results,
    totalDurationMs: Date.now() - startedAt
  }
}
