import { basename, dirname, extname, join } from 'node:path'
import {
  directRename,
  pathExists,
  permanentDelete,
  readTextFile,
  renameWithCollision,
  writeTextFile
} from '../../core/fs-ops.mjs'
import { collectFailures, finishReport } from '../../core/task-report.mjs'
import {
  ILLEGAL_NAME_RE,
  TRAILING_DOT_SPACE_RE,
  validateRenameTargets,
  WINDOWS_RESERVED_NAME_RE
} from '../../../shared/rename-rules.mjs'

// 为兼容未开启 LongPathsEnabled 的 Windows 环境，目标完整路径保留安全余量。
const WINDOWS_SAFE_PATH_MAX = 240

/**
 * 两阶段改名（冻结稿 §5）：
 * 阶段一全部改为临时名（规避 A→B、B→A 互换死锁），阶段二改为目标名（重名自动 (n)）。
 * 视频与 poster 成组处理：poster 同步改为 <新词干>-poster.jpg。
 *
 * 崩溃恢复（S8）：阶段一前把全部操作写入 journal 文件；应用崩溃/中断后
 * msd_tmp_* 临时文件可由 recoverRenameJournal 按 journal 续跑阶段二（落到目标名）。
 * 正常结束（无残留临时文件）后 journal 自动删除。
 *
 * @param {string} root 工作区根
 * @param {Array} pairs RenamePairInput[]
 * @param {object} options { taskCenter, taskId, concurrency, journalPath }
 */
export async function executeRename(
  root,
  pairs,
  { taskCenter, taskId, concurrency = 5, journalPath }
) {
  const startedAt = Date.now()
  const errors = validateRenameTargets(pairs, (pair) => {
    const videoExt = pair.newExt ?? extname(pair.videoRel)
    const targets = [join(dirname(pair.videoRel), `${pair.newStem}${videoExt}`)]
    if (pair.posterRel && !pair.newExt) {
      targets.push(join(dirname(pair.posterRel), `${pair.newStem}-poster.jpg`))
    }
    return targets
  })
  for (const pair of pairs) {
    if (pair.newExt) {
      const extensionError = validateTargetExtension(pair.newExt)
      if (extensionError) errors[pair.videoRel] = extensionError
    }
    const pathError = validateTargetPaths(root, pair)
    if (pathError) errors[pair.videoRel] = pathError
  }
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

  // 阶段一前落 journal：进程崩溃后下次启动可续跑阶段二，不留 msd_tmp_* 残留
  if (journalPath) {
    await writeJournal(journalPath, ops).catch(() => {})
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
  collectFailures(report, phase1, ops, 'rel')

  // 阶段二：临时名 → 目标名（重名自动 (n)）。
  // 即使阶段一失败或被取消，也必须把已改临时名的文件落到目标名，避免残留 msd_tmp_* 文件。
  const phase2Ops = ops.filter((_, index) => phase1.results[index]?.ok)
  let cancelled = phase1.cancelled
  if (phase2Ops.length > 0) {
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
    collectFailures(report, phase2, phase2Ops, 'rel')
    cancelled = cancelled || phase2.cancelled
  }

  // journal 收尾：仍有残留临时文件（取消/失败）时保留 journal 供下次恢复，否则删除
  if (journalPath) {
    const leftover = []
    for (const op of ops) {
      if (await pathExists(op.temp)) leftover.push(op)
    }
    if (leftover.length > 0) {
      await writeJournal(journalPath, leftover).catch(() => {})
    } else {
      await permanentDelete(journalPath).catch(() => {})
    }
  }

  return finishReport(report, startedAt, cancelled)
}

/**
 * Windows 默认 MAX_PATH 仍可能在未启用 LongPathsEnabled 的设备上生效。
 * 改名前预检视频及其关联海报的最终完整路径，避免阶段一完成后才因 ENAMETOOLONG 留下临时名。
 */
function validateTargetPaths(root, pair) {
  if (process.platform !== 'win32') return null
  const videoRel = String(pair.videoRel ?? '')
  const videoExt = extname(videoRel)
  const finalVideoName = pair.newExt
    ? `${pair.newStem}${pair.newExt}`
    : `${pair.newStem}${videoExt}`
  const targets = [join(dirname(join(root, videoRel)), finalVideoName)]
  if (pair.posterRel && !pair.newExt) {
    targets.push(join(dirname(join(root, pair.posterRel)), `${pair.newStem}-poster.jpg`))
  }
  return targets.some((target) => target.length > WINDOWS_SAFE_PATH_MAX)
    ? `目标完整路径过长，Windows 兼容路径不能超过 ${WINDOWS_SAFE_PATH_MAX} 个字符`
    : null
}

/**
 * 仅改扩展名也必须通过 Windows 文件名规则：禁止路径分隔符、非法字符、空白/点号结尾。
 * 扩展名只接受常规 ASCII 字母数字形式，避免 IPC 输入直接拼接为危险目标名。
 */
function validateTargetExtension(extension) {
  if (typeof extension !== 'string' || !/^\.[A-Za-z0-9]{1,16}$/.test(extension)) {
    return '扩展名无效，只允许 . 后跟 1–16 位英文字母或数字'
  }
  if (
    ILLEGAL_NAME_RE.test(extension) ||
    TRAILING_DOT_SPACE_RE.test(extension) ||
    WINDOWS_RESERVED_NAME_RE.test(extension)
  ) {
    return '扩展名不符合 Windows 文件名规则'
  }
  return null
}

/** 写恢复 journal（只记录恢复所需的最小字段） */
async function writeJournal(journalPath, ops) {
  await writeTextFile(
    journalPath,
    JSON.stringify(
      {
        version: 1,
        savedAt: new Date().toISOString(),
        ops: ops.map((op) => ({ rel: op.rel, temp: op.temp, finalName: op.finalName }))
      },
      null,
      2
    )
  )
}

/**
 * 崩溃恢复：按 journal 把残留的 msd_tmp_* 临时文件续跑到目标名。
 * 临时文件已不存在（阶段一未执行到该项就中断）的条目跳过；恢复失败的条目保留在 journal 中供下次重试。
 * 返回 { recovered, skipped }；journal 不存在/损坏时返回 null。
 */
export async function recoverRenameJournal(journalPath) {
  let journal
  try {
    journal = JSON.parse(await readTextFile(journalPath))
  } catch {
    return null
  }
  const ops = Array.isArray(journal?.ops) ? journal.ops : []
  const retryOps = []
  let recovered = 0
  let skipped = 0
  for (const op of ops) {
    if (!op?.temp || !op?.finalName) {
      skipped += 1
      continue
    }
    if (!(await pathExists(op.temp))) {
      skipped += 1 // 阶段一未轮到该项：源文件仍在原地，无需处理
      continue
    }
    try {
      await renameWithCollision(op.temp, op.finalName)
      recovered += 1
    } catch {
      skipped += 1
      // Windows 文件锁、权限或网络盘瞬态故障下，下次启动仍应能继续恢复。
      retryOps.push(op)
    }
  }
  if (retryOps.length > 0) {
    await writeJournal(journalPath, retryOps)
  } else {
    await permanentDelete(journalPath).catch(() => {})
  }
  return { recovered, skipped }
}
