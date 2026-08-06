import { basename, dirname, extname, join } from 'node:path'
import { directRename, renameWithCollision } from '../../core/fs-ops.mjs'
import { validateStems } from '../../../shared/rename-rules.mjs'

/**
 * 两阶段改名（冻结稿 §5）：
 * 阶段一全部改为临时名（规避 A→B、B→A 互换死锁），阶段二改为目标名（重名自动 (n)）。
 * 视频与 poster 成组处理：poster 同步改为 <新词干>-poster.jpg。
 *
 * @param {string} root 工作区根
 * @param {Array} pairs RenamePairInput[]
 * @param {object} options { taskCenter, taskId, concurrency }
 */
export async function executeRename(root, pairs, { taskCenter, taskId, concurrency = 5 }) {
  const startedAt = Date.now()
  const errors = validateStems(pairs.filter((p) => !p.newExt))
  if (Object.keys(errors).length > 0) {
    const [rel, message] = Object.entries(errors)[0]
    throw new Error(`命名校验未通过：${rel} —— ${message}`)
  }

  // 展开为文件级操作（视频 + poster）
  const stamp = Date.now()
  const ops = []
  pairs.forEach((pair, index) => {
    const videoAbs = join(root, pair.videoRel)
    const videoExt = extname(pair.videoRel)
    const finalVideoName = pair.newExt
      ? `${pair.newStem}${pair.newExt}`
      : `${pair.newStem}${videoExt}`
    if (basename(videoAbs) !== finalVideoName) {
      ops.push({
        rel: pair.videoRel,
        from: videoAbs,
        temp: join(dirname(videoAbs), `msd_tmp_${stamp}_${index}_v${videoExt}`),
        finalName: finalVideoName
      })
    }
    if (pair.posterRel && !pair.newExt) {
      const posterAbs = join(root, pair.posterRel)
      const finalPosterName = `${pair.newStem}-poster.jpg`
      if (basename(posterAbs) !== finalPosterName) {
        ops.push({
          rel: pair.posterRel,
          from: posterAbs,
          temp: join(dirname(posterAbs), `msd_tmp_${stamp}_${index}_p${extname(posterAbs)}`),
          finalName: finalPosterName
        })
      }
    }
  })

  const report = {
    taskId,
    cancelled: false,
    renamedCount: 0,
    items: [],
    failed: [],
    durationMs: 0
  }
  if (ops.length === 0) {
    report.durationMs = Date.now() - startedAt
    return report
  }

  // 阶段一：改为唯一临时名
  const phase1 = await taskCenter.run({
    taskId,
    label: '重命名（阶段一）',
    items: ops,
    concurrency,
    worker: async (op) => {
      await directRename(op.from, op.temp)
    }
  })
  collectFailures(report, phase1, ops)
  if (phase1.cancelled) return finish(report, startedAt, true)
  if (report.failed.length > 0) return finish(report, startedAt, false)

  // 阶段二：临时名 → 目标名（重名自动 (n)）
  const phase2Ops = ops.filter((_, index) => phase1.results[index]?.ok)
  const phase2 = await taskCenter.run({
    taskId,
    label: '重命名（阶段二）',
    items: phase2Ops,
    concurrency,
    worker: async (op) => {
      const finalPath = await renameWithCollision(op.temp, op.finalName)
      report.renamedCount += 1
      report.items.push({ from: op.rel, to: basename(finalPath) })
    }
  })
  collectFailures(report, phase2, phase2Ops)
  return finish(report, startedAt, phase2.cancelled)
}

function collectFailures(report, result, ops) {
  result.results.forEach((entry, index) => {
    if (!entry.ok && !entry.cancelled) {
      report.failed.push({ target: ops[index].rel, error: entry.error ?? '未知错误' })
    }
  })
}

function finish(report, startedAt, cancelled) {
  report.cancelled = cancelled
  report.durationMs = Date.now() - startedAt
  return report
}
