import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDir, ensureUniquePath, permanentDelete, writeTextFile } from '../../core/fs-ops.mjs'
import { probeMedia } from '../../core/probe.mjs'
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
 */
function runFfmpeg(ffmpegPath, args, { signal, onProgress, totalMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-progress', 'pipe:1', '-nostats', ...args], { signal })
    let stderr = ''
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const match = line.match(/^out_time_ms=(\d+)/)
        if (match && totalMs > 0 && onProgress) {
          const doneMs = Number(match[1]) / 1000 // ffmpeg progress 单位是微秒
          onProgress(Math.min(99, Math.round((doneMs / totalMs) * 100)))
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      reject(signal?.aborted ? new Error('已取消') : error)
    })
    child.on('close', (code, termSignal) => {
      if (signal?.aborted) return reject(new Error('已取消'))
      if (code === 0) return resolve()
      reject(
        new Error(
          `ffmpeg 异常退出（code=${code} signal=${termSignal}）args=${args.join(' ')} ：${stderr.slice(-300) || '无错误输出'}`
        )
      )
    })
  })
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
  const workDir = join(tmpdir(), `msd-merge-${Date.now()}`)
  await ensureDir(workDir)
  const outputPath = await ensureUniquePath(join(outputDir, outputName))
  const compatibility = checkCompatibility(items)
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
        await runFfmpeg(ffmpegPath, buildTranscodeArgs(item.path, target, segment), {
          signal,
          totalMs: item.media?.durationMs ?? 0,
          onProgress: (pct) =>
            onProgress?.(base + Math.round((pct / 100) * span), `转码统一 ${i + 1}/${items.length}`)
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
      return {
        cancelled: true,
        outputPath: null,
        verified: false,
        verifyNote: '已取消',
        transcoded: false
      }
    }
    return {
      cancelled: false,
      outputPath: null,
      verified: false,
      verifyNote: '合并失败',
      transcoded: !compatibility.compatible,
      error: error.message
    }
  } finally {
    await permanentDelete(workDir)
  }
}

/** 校验通过后删除参与合并的源视频与关联 poster（冻结稿 §4：单独确认后执行） */
export async function deleteMergeSources(root, items, { taskCenter, taskId, concurrency = 5 }) {
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
      await permanentDelete(join(root, file.rel))
    }
  })
  const failed = []
  result.results.forEach((entry, index) => {
    if (!entry.ok && !entry.cancelled) {
      failed.push({ target: files[index].rel, error: entry.error ?? '未知错误' })
    }
  })
  return {
    cancelled: result.cancelled,
    deletedCount: result.completed,
    failed
  }
}
