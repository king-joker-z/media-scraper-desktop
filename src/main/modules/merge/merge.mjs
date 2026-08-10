import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureDir,
  ensureUniquePath,
  pathExists,
  permanentDelete,
  writeTextFile
} from '../../core/fs-ops.mjs'
import { probeMedia } from '../../core/probe.mjs'
import { spawnPooled } from '../../core/ffmpeg-pool.mjs'
import { collectFailures } from '../../core/task-report.mjs'
import {
  buildConcatCopyArgs,
  buildConcatList,
  buildConcatSegmentsArgs,
  buildTranscodeArgs,
  checkCompatibility,
  verifyMergeOutput
} from '../../../shared/merge-rules.mjs'

/**
 * 运行 ffmpeg 子进程，解析 -progress 输出上报百分比，支持 AbortSignal 取消。
 * spawnPooled 托管：进程注册管理（退出即释放句柄）+ 进程池限流，
 * 取消时 SIGTERM→SIGKILL 兜底；stderr 只留尾部 2000 字符，防长视频转码的错误输出无限累积。
 */
function runFfmpeg(ffmpegPath, args, { signal, onProgress, totalMs }) {
  let stderrTail = ''
  let buffer = ''
  return spawnPooled(ffmpegPath, ['-progress', 'pipe:1', '-nostats', ...args], {
    signal,
    onStdout: (text) => {
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const match = line.match(/^out_time_ms=(\d+)/)
        if (match && totalMs > 0 && onProgress) {
          const doneMs = Number(match[1]) / 1000 // ffmpeg progress 单位是微秒
          onProgress(Math.min(99, Math.round((doneMs / totalMs) * 100)))
        }
      }
    },
    onStderr: (text) => {
      stderrTail = (stderrTail + text).slice(-2000)
    }
  }).then(({ code, signal: termSignal, cancelled }) => {
    if (cancelled) throw new Error('已取消')
    if (code === 0) return
    throw new Error(
      `ffmpeg 异常退出（code=${code} signal=${termSignal}）args=${args.join(' ')} ：${stderrTail.slice(-300) || '无错误输出'}`
    )
  })
}

/** 确定性临时目录：同一片段集合 + 同一目标参数 → 同一目录，支撑断点续传 */
export function mergeWorkDir(items, target) {
  const key = items.map((item) => item.path).join('|') + JSON.stringify(target ?? {})
  const hash = createHash('md5').update(key).digest('hex').slice(0, 10)
  return join(tmpdir(), `msd-merge-${hash}`)
}

/**
 * 中间段是否已就绪：存在、可读、且时长与源片段一致（±1s）。
 * 时长校验是关键——上次取消留下的截断段必须重转，否则输出时长校验会失败。
 */
async function segmentReady(segment, ffprobePath, expectedMs) {
  if (!(await pathExists(segment))) return false
  try {
    const info = await probeMedia(segment, ffprobePath)
    if (expectedMs > 0 && Math.abs(info.durationMs - expectedMs) > 1000) return false
    return true
  } catch {
    return false
  }
}

/**
 * 合并视频（冻结稿 §4）：
 * 兼容 → concat 无重编码拼接；不兼容 → 逐段转码为统一参数 TS 后再拼接。
 * 完成后校验输出（可读、时长、音视频流）。
 *
 * @param {object} options
 * @param {Array<{path: string, name: string, media: object}>} options.items 有序片段
 * @param {string} options.outputDir 输出目录（工作区根）
 * @param {string} options.outputName 输出文件名
 * @param {string} options.ffmpegPath
 * @param {string} options.ffprobePath
 * @param {(percent: number, stage: string) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 */
export async function mergeVideos({
  items,
  outputDir,
  outputName,
  ffmpegPath,
  ffprobePath,
  onProgress,
  signal
}) {
  const compatibility = checkCompatibility(items)
  const workDir = mergeWorkDir(items, compatibility.target)
  await ensureDir(workDir)
  const outputPath = await ensureUniquePath(join(outputDir, outputName))
  const totalMs = items.reduce((sum, item) => sum + (item.media?.durationMs ?? 0), 0)

  try {
    if (compatibility.compatible) {
      // ---- 无重编码拼接 ----
      onProgress?.(1, '无重编码拼接中')
      const listPath = join(workDir, 'concat.txt')
      await writeTextFile(listPath, buildConcatList(items.map((item) => item.path)))
      await runFfmpeg(ffmpegPath, buildConcatCopyArgs(listPath, outputPath), {
        signal,
        totalMs,
        onProgress: (pct) => onProgress?.(pct, '无重编码拼接中')
      })
    } else {
      // ---- 转码统一后拼接 ----
      const target = compatibility.target
      const segments = []
      for (let i = 0; i < items.length; i += 1) {
        if (signal?.aborted) throw new Error('已取消')
        const item = items[i]
        const segment = join(workDir, `seg-${String(i).padStart(3, '0')}.mp4`)
        const base = Math.round((i / items.length) * 90)
        const span = Math.round(90 / items.length)
        // 断点续传：已就绪的中间段直接跳过
        if (await segmentReady(segment, ffprobePath, item.media?.durationMs ?? 0)) {
          onProgress?.(base + span, `跳过已完成段 ${i + 1}/${items.length} · ${item.name}`)
          segments.push(segment)
          continue
        }
        await runFfmpeg(ffmpegPath, buildTranscodeArgs(item.path, target, segment), {
          signal,
          totalMs: item.media?.durationMs ?? 0,
          onProgress: (pct) =>
            onProgress?.(
              base + Math.round((pct / 100) * span),
              `转码统一 ${i + 1}/${items.length} · ${item.name} ${pct}%`
            )
        })
        segments.push(segment)
      }
      onProgress?.(92, '拼接中')
      const listPath = join(workDir, 'concat.txt')
      await writeTextFile(listPath, buildConcatList(segments))
      await runFfmpeg(ffmpegPath, buildConcatSegmentsArgs(listPath, outputPath), {
        signal,
        totalMs,
        onProgress: (pct) => onProgress?.(92 + Math.round(pct * 0.07), '拼接中')
      })
    }

    // ---- 校验 ----
    onProgress?.(99, '校验输出')
    const outputMedia = await probeMedia(outputPath, ffprobePath)
    const verify = verifyMergeOutput(outputMedia, items)
    if (!verify.ok) {
      await permanentDelete(outputPath)
      return {
        cancelled: false,
        outputPath: null,
        verified: false,
        verifyNote: `校验失败：${verify.note}（已删除损坏输出，源文件未动）`,
        transcoded: !compatibility.compatible
      }
    }
    onProgress?.(100, '完成')
    return {
      cancelled: false,
      outputPath,
      verified: true,
      verifyNote: verify.note,
      transcoded: !compatibility.compatible
    }
  } catch (error) {
    const cancelled = signal?.aborted || error.message === '已取消'
    await permanentDelete(outputPath)
    if (cancelled) {
      // 取消：保留中间产物，下次同参数合并可断点续传
      return {
        cancelled: true,
        outputPath: null,
        verified: false,
        verifyNote: '已取消（已完成的转码段已保留，下次继续）',
        transcoded: false
      }
    }
    return {
      cancelled: false,
      outputPath: null,
      verified: false,
      verifyNote: '合并失败（已完成的转码段已保留，重新执行可续传）',
      transcoded: !compatibility.compatible,
      error: error.message
    }
  } finally {
    // 成功：清理临时目录；失败/取消：保留供断点续传
    if (await pathExists(outputPath)) await permanentDelete(workDir)
  }
}

/** 校验通过后删除参与合并的源视频与关联 poster（冻结稿 §4：单独确认后执行） */
export async function deleteMergeSources(
  root,
  items,
  { taskCenter, taskId, concurrency = 5, deleteFn = permanentDelete }
) {
  const files = items.flatMap((item) => [
    { rel: item.videoRel, kind: '视频' },
    ...(item.posterRel ? [{ rel: item.posterRel, kind: 'poster' }] : [])
  ])
  const result = await taskCenter.run({
    taskId,
    label: '删除源片段',
    items: files,
    concurrency,
    worker: async (file) => {
      await deleteFn(join(root, file.rel))
    }
  })
  const report = { failed: [] }
  collectFailures(report, result, files, 'rel')
  return {
    cancelled: result.cancelled,
    deletedCount: result.completed,
    failed: report.failed
  }
}
