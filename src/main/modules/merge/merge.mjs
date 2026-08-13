import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commitStagedFile,
  createStagingPath,
  discardStagedFile,
  ensureDir,
  fileMtimeMs,
  ensureUniquePath,
  permanentDelete,
  writeTextFile
} from '../../core/fs-ops.mjs'
import { probeMedia } from '../../core/probe.mjs'
import { spawnPooled } from '../../core/ffmpeg-pool.mjs'
import { probeNvencCapability } from '../../core/nvenc.mjs'
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
    gracefulQuit: 'ffmpeg',
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
export function mergeWorkDir(items, target, encoder = 'cpu') {
  const key = JSON.stringify({
    version: 2,
    items: items.map((item) => ({
      path: item.path,
      sizeBytes: item.media?.sizeBytes ?? null,
      durationMs: item.media?.durationMs ?? null,
      sourceMtimeMs: item.sourceMtimeMs ?? null
    })),
    target: target ?? {},
    encoder
  })
  const hash = createHash('md5').update(key).digest('hex').slice(0, 10)
  return join(tmpdir(), `msd-merge-${hash}`)
}

/**
 * 中间段是否已就绪：存在、体积正常（≥1KB，排除取消残留的近乎空壳）、
 * 可被 ffprobe 解析、且时长与源片段一致（±1s）。
 * 时长+可解析校验是关键——取消（尤其 Windows 强杀）留下的截断/无 moov 段必须重转，
 * 否则输出时长校验会失败。
 */
async function segmentReady(segment, ffprobePath, expectedMs) {
  try {
    const info = await probeMedia(segment, ffprobePath)
    if ((info.sizeBytes ?? 0) < 1024) return false
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
 * @param {boolean} [options.nvencEnabled] 是否允许 NVIDIA NVENC 编码加速；不可用时先探测再回退 CPU
 * @param {(ffmpegPath: string) => Promise<{available: boolean, reason?: string}>} [options.probeNvenc]
 */
export async function mergeVideos({
  items,
  outputDir,
  outputName,
  ffmpegPath,
  ffprobePath,
  onProgress,
  signal,
  nvencEnabled = false,
  probeNvenc = probeNvencCapability
}) {
  const compatibility = checkCompatibility(items)
  const unreadableItems = items.filter((item) => !item.media)
  if (unreadableItems.length > 0 || (!compatibility.compatible && !compatibility.target)) {
    return {
      cancelled: false,
      outputPath: null,
      verified: false,
      verifyNote: '合并前检查失败：存在无法读取媒体信息的视频，不能安全执行合并',
      transcoded: false,
      videoEncoder: 'copy',
      error: unreadableItems.map((item) => item.name).join('、')
    }
  }
  let activeEncoder = 'cpu'
  let nvencFallbackReason = ''
  if (!compatibility.compatible && nvencEnabled) {
    onProgress?.(0, '检测 NVIDIA NVENC 编码能力')
    try {
      const nvenc = await probeNvenc(ffmpegPath)
      if (nvenc.available) {
        activeEncoder = 'nvenc'
      } else {
        nvencFallbackReason = nvenc.reason || '随附 FFmpeg、NVIDIA 驱动或显卡无法初始化 H.264 NVENC'
      }
    } catch (error) {
      nvencFallbackReason = `能力检测异常：${error instanceof Error ? error.message : String(error)}`
    }
    if (nvencFallbackReason) {
      onProgress?.(0, '⚠ NVIDIA NVENC 不可用，已自动回退 CPU x264 编码')
    }
  }
  // 每次执行重新读取 mtime，避免同路径同大小/时长的覆盖文件错误命中断点缓存。
  let versionedItems
  try {
    versionedItems = await Promise.all(
      items.map(async (item) => ({ ...item, sourceMtimeMs: await fileMtimeMs(item.path) }))
    )
  } catch (error) {
    return {
      cancelled: false,
      outputPath: null,
      verified: false,
      verifyNote: '合并前检查失败：源文件在执行前已被移动、删除或无法访问',
      transcoded: false,
      videoEncoder: 'copy',
      error: error instanceof Error ? error.message : String(error)
    }
  }
  // 目录包含编码器和源媒体版本，断点缓存不会在不同编码器或源文件变更后混用。
  let workDir = mergeWorkDir(versionedItems, compatibility.target, activeEncoder)
  await ensureDir(workDir)
  const outputPath = await ensureUniquePath(join(outputDir, outputName))
  // ffmpeg 只写入同目录隐藏暂存文件；避免 Windows 资源管理器在正式 MP4 尚未落盘时
  // 触发缩略图/索引读取，并在验证通过后才以 rename 原子提交。
  const stagingPath = createStagingPath(outputPath)
  const totalMs = items.reduce((sum, item) => sum + (item.media?.durationMs ?? 0), 0)
  let verified = false

  try {
    if (compatibility.compatible) {
      // ---- 无重编码拼接 ----
      onProgress?.(1, '无重编码拼接中')
      const listPath = join(workDir, 'concat.txt')
      await writeTextFile(listPath, buildConcatList(items.map((item) => item.path)))
      await runFfmpeg(ffmpegPath, buildConcatCopyArgs(listPath, stagingPath), {
        signal,
        totalMs,
        onProgress: (pct) => onProgress?.(pct, '无重编码拼接中')
      })
    } else {
      // ---- 转码统一后拼接 ----
      const target = compatibility.target
      let segments = []
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
        const transcode = (encoder) =>
          runFfmpeg(
            ffmpegPath,
            buildTranscodeArgs(item.path, target, segment, {
              encoder,
              hasAudio: Boolean(item.media?.audioCodec)
            }),
            {
              signal,
              totalMs: item.media?.durationMs ?? 0,
              onProgress: (pct) =>
                onProgress?.(
                  base + Math.round((pct / 100) * span),
                  `转码统一 ${i + 1}/${items.length} · ${item.name} ${pct}%${
                    encoder === 'nvenc' ? '（NVIDIA）' : ''
                  }`
                )
            }
          )
        // 能力已由独立烟测确认。业务转码失败通常是输入、磁盘、权限或滤镜问题，不能误判 NVENC 后重跑一遍。
        await transcode(activeEncoder)
        segments.push(segment)
      }
      onProgress?.(92, '拼接中')
      const listPath = join(workDir, 'concat.txt')
      await writeTextFile(listPath, buildConcatList(segments))
      await runFfmpeg(ffmpegPath, buildConcatSegmentsArgs(listPath, stagingPath), {
        signal,
        totalMs,
        onProgress: (pct) => onProgress?.(92 + Math.round(pct * 0.07), '拼接中')
      })
    }

    // ---- 校验 ----
    onProgress?.(99, '校验输出')
    const outputMedia = await probeMedia(stagingPath, ffprobePath)
    const verify = verifyMergeOutput(outputMedia, items)
    if (!verify.ok) {
      await discardStagedFile(stagingPath).catch(() => {})
      return {
        cancelled: false,
        outputPath: null,
        verified: false,
        verifyNote: `校验失败：${verify.note}（已删除损坏输出，源文件未动）`,
        transcoded: !compatibility.compatible,
        videoEncoder: compatibility.compatible ? 'copy' : activeEncoder,
        ...(nvencFallbackReason ? { nvencFallbackReason } : {})
      }
    }
    await commitStagedFile(stagingPath, outputPath)
    verified = true
    onProgress?.(100, '完成')
    return {
      cancelled: false,
      outputPath,
      verified: true,
      verifyNote: `${verify.note}${
        !compatibility.compatible
          ? `（${activeEncoder === 'nvenc' ? 'NVIDIA NVENC 视频编码；解码和缩放由 CPU 完成' : 'CPU x264'}）`
          : ''
      }`,
      transcoded: !compatibility.compatible,
      videoEncoder: compatibility.compatible ? 'copy' : activeEncoder,
      ...(nvencFallbackReason ? { nvencFallbackReason } : {})
    }
  } catch (error) {
    const cancelled = signal?.aborted || error.message === '已取消'
    await discardStagedFile(stagingPath).catch(() => {})
    if (cancelled) {
      // 取消：保留中间产物，下次同参数合并可断点续传
      return {
        cancelled: true,
        outputPath: null,
        verified: false,
        verifyNote: compatibility.compatible
          ? '已取消（临时输出已清理；无重编码拼接下次会重新执行）'
          : '已取消（已完成的转码段已保留，下次继续）',
        transcoded: false,
        videoEncoder: compatibility.compatible ? 'copy' : activeEncoder,
        ...(nvencFallbackReason ? { nvencFallbackReason } : {})
      }
    }
    return {
      cancelled: false,
      outputPath: null,
      verified: false,
      verifyNote: '合并失败（已完成的转码段已保留，重新执行可续传）',
      transcoded: !compatibility.compatible,
      videoEncoder: compatibility.compatible ? 'copy' : activeEncoder,
      ...(nvencFallbackReason ? { nvencFallbackReason } : {}),
      error: error.message
    }
  } finally {
    // 仅在输出已通过完整校验时清理临时目录；失败/取消保留供断点续传。
    // Windows 索引器、杀软瞬态占用时，清理失败不能否定已经提交并校验过的输出。
    if (verified) await permanentDelete(workDir).catch(() => {})
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
    worker: async (file, signal) => {
      if (signal?.aborted) throw new Error('已取消')
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
