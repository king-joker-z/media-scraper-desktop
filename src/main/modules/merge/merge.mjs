import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  createMergeTransactionPath,
  createStagingPath,
  discardStagedFile,
  diskFreeBytes,
  ensureDir,
  fileMtimeMs,
  ensureUniquePath,
  fileSystemId,
  installStagedFileIfAbsent,
  permanentDelete,
  writeAtomicTextFile,
  writeTextFile
} from '../../core/fs-ops.mjs'
import { probeMedia } from '../../core/probe.mjs'
import { spawnPooled } from '../../core/ffmpeg-pool.mjs'
import { probeCudaPipelineCapability, probeNvencCapability } from '../../core/nvenc.mjs'
import { collectFailures } from '../../core/task-report.mjs'
import {
  buildConcatCopyArgs,
  buildConcatList,
  buildConcatSegmentsArgs,
  buildTranscodeArgs,
  checkCompatibility,
  estimateOutputBytes,
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

/** 判断实际转码失败是否来自 NVENC 设备、驱动或编码会话，而非输入媒体/滤镜/磁盘错误。 */
function isNvencRuntimeFailure(error) {
  const message = String(error?.message ?? error).toLowerCase()
  return /no nvenc capable devices|no capable devices|cannot load nvcuda|openencodesession|initializeencoder failed|error while opening encoder|failed setup for format cuda|nvenc[\s\S]{0,300}(?:fail|error)|cuda(?:_error)?|too many concurrent|unsupported.*(?:device|encode)|device.*(?:not available|not supported)|no such filter.*(?:cuda)|failed to (?:inject|configure).*?(?:cuda|filter)|impossible to convert.*cuda/.test(
    message
  )
}

/** 确定性临时目录：同一片段集合 + 同一目标参数 → 同一目录，支撑断点续传 */
export function mergeWorkDir(items, target, encoder = 'cpu', tempRoot = tmpdir()) {
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
  return join(tempRoot, `msd-merge-${hash}`)
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
 * @param {(dir: string) => Promise<number>} [options.diskFree] 查询指定目录所在卷的可用字节数（测试可注入）
 * @param {(dir: string) => Promise<string|number>} [options.volumeId] 查询目录所在卷标识（测试可注入）
 * @param {typeof runFfmpeg} [options.runFfmpegImpl] FFmpeg 执行器（仅测试注入）
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
  cudaPipelineEnabled = false,
  mergeTranscodeConcurrency = 1,
  tempDirectory = '',
  probeNvenc = probeNvencCapability,
  probeCudaPipeline = probeCudaPipelineCapability,
  diskFree = diskFreeBytes,
  volumeId = fileSystemId,
  runFfmpegImpl = runFfmpeg
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
  let cudaPipelineAvailable = false
  let nvencFallbackReason = ''
  if (!compatibility.compatible && nvencEnabled) {
    onProgress?.(0, '检测 NVIDIA NVENC 编码能力')
    try {
      const nvenc = await probeNvenc(ffmpegPath)
      if (nvenc.available) {
        activeEncoder = 'nvenc'
        if (cudaPipelineEnabled) {
          const cuda = await probeCudaPipeline(ffmpegPath)
          if (cuda.available) {
            activeEncoder = 'cuda-nvenc'
            cudaPipelineAvailable = true
          } else {
            onProgress?.(0, 'CUDA 完整流水线不可用，将使用 NVIDIA 编码 + CPU 缩放')
          }
        }
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
  const resolvedTempRoot =
    typeof tempDirectory === 'string' && tempDirectory && isAbsolute(tempDirectory)
      ? tempDirectory
      : tmpdir()
  let workDir = mergeWorkDir(versionedItems, compatibility.target, activeEncoder, resolvedTempRoot)
  let outputPath
  try {
    await ensureDir(workDir)
    outputPath = await ensureUniquePath(join(outputDir, outputName))
  } catch (error) {
    return {
      cancelled: false,
      outputPath: null,
      verified: false,
      verifyNote: '合并前检查失败：无法创建临时目录或分配输出路径',
      transcoded: false,
      videoEncoder: activeEncoder,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  // ffmpeg 只写入同目录隐藏暂存文件；避免 Windows 资源管理器在正式 MP4 尚未落盘时
  // 触发缩略图/索引读取，并在验证通过后才以 rename 原子提交。
  const stagingPath = createStagingPath(outputPath)
  const totalMs = items.reduce((sum, item) => sum + (item.media?.durationMs ?? 0), 0)
  const estimatedBytes = estimateOutputBytes(items, compatibility.compatible)
  // 输出估算可能低于 CRF/CQ 实际大小；每份产物预留 25% + 最少 64MB，避免临界写满。
  const reservePerArtifact = Math.ceil(estimatedBytes * 1.25 + 64 * 1024 * 1024)
  const ensureOutputSpace = async () => {
    const freeBytes = await diskFree(outputDir)
    if (freeBytes < reservePerArtifact) {
      throw new Error(
        `输出盘可用空间不足，建议预留约 ${(reservePerArtifact / 1024 / 1024).toFixed(0)} MB`
      )
    }
  }
  if (compatibility.compatible) {
    try {
      await ensureOutputSpace()
    } catch (error) {
      const code = error?.code
      const message = error instanceof Error ? error.message : String(error)
      if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code)) {
        return {
          cancelled: false,
          outputPath: null,
          verified: false,
          verifyNote: `合并前检查失败：无法确认输出盘可用空间（${message}）`,
          transcoded: false,
          videoEncoder: 'copy',
          error: message
        }
      }
      onProgress?.(0, '无法读取输出盘可用空间，将由 FFmpeg 在写入时校验')
    }
  } else {
    try {
      const [tempFreeBytes, outputFreeBytes, tempVolume, outputVolume] = await Promise.all([
        diskFree(workDir),
        diskFree(outputDir),
        volumeId(workDir),
        volumeId(outputDir)
      ])
      const sameVolume = tempVolume === outputVolume
      const requiredTempBytes = sameVolume ? reservePerArtifact * 2 : reservePerArtifact
      if (
        tempFreeBytes < requiredTempBytes ||
        (!sameVolume && outputFreeBytes < reservePerArtifact)
      ) {
        const insufficient = sameVolume
          ? '临时目录与输出目录所在磁盘'
          : [
              ...(tempFreeBytes < reservePerArtifact ? ['系统临时盘'] : []),
              ...(outputFreeBytes < reservePerArtifact ? ['输出盘'] : [])
            ].join('、')
        return {
          cancelled: false,
          outputPath: null,
          verified: false,
          verifyNote: `合并前检查失败：${insufficient}可用空间不足，转码峰值建议预留约 ${(requiredTempBytes / 1024 / 1024).toFixed(0)} MB`,
          transcoded: false,
          videoEncoder: activeEncoder
        }
      }
    } catch (error) {
      const code = error?.code
      const message = error instanceof Error ? error.message : String(error)
      // 仅明确“不支持统计”的文件系统允许降级；权限、断连和路径错误必须直接报告。
      if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code)) {
        return {
          cancelled: false,
          outputPath: null,
          verified: false,
          verifyNote: `合并前检查失败：无法读取临时目录或输出目录的可用空间（${message}）`,
          transcoded: false,
          videoEncoder: activeEncoder,
          error: message
        }
      }
      onProgress?.(0, '无法读取磁盘可用空间，将由 FFmpeg 在写入时校验')
    }
  }
  const transactionPath = createMergeTransactionPath(outputDir)
  const transaction = {
    version: 2,
    state: 'writing',
    staging: stagingPath,
    target: outputPath
  }
  try {
    // 先记录写入意图：主进程在 FFmpeg 写暂存期间异常退出时，扫描可安全清理未校验产物。
    await writeAtomicTextFile(transactionPath, JSON.stringify(transaction))
  } catch (error) {
    return {
      cancelled: false,
      outputPath: null,
      verified: false,
      verifyNote: '合并前检查失败：无法创建输出事务记录',
      transcoded: false,
      videoEncoder: activeEncoder,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  let verified = false
  let transactionCleanupPending = false
  let gpuSummary = {
    requested: nvencEnabled,
    encoder: compatibility.compatible ? 'copy' : activeEncoder === 'cpu' ? 'cpu' : 'nvenc',
    pipeline: compatibility.compatible
      ? 'copy'
      : activeEncoder === 'cuda-nvenc'
        ? 'cuda-nvenc'
        : activeEncoder,
    hardwareSegments: 0,
    fallbackSegments: 0,
    note: compatibility.compatible ? '参数一致，采用无重编码拼接（GPU 不参与）' : '等待转码执行'
  }

  try {
    if (compatibility.compatible) {
      // ---- 无重编码拼接 ----
      onProgress?.(1, '无重编码拼接中')
      const listPath = join(workDir, 'concat.txt')
      await writeTextFile(listPath, buildConcatList(items.map((item) => item.path)))
      await runFfmpegImpl(ffmpegPath, buildConcatCopyArgs(listPath, stagingPath), {
        signal,
        totalMs,
        onProgress: (pct) => onProgress?.(pct, '无重编码拼接中')
      })
    } else {
      // ---- 转码统一后拼接 ----
      const target = compatibility.target
      const requestedConcurrency = Math.min(4, Math.max(1, Math.round(mergeTranscodeConcurrency)))
      // GPU 会话/显存更敏感：完整 CUDA 路径最多两路；默认值为 1，维持原有最稳行为。
      const transcodeConcurrency =
        activeEncoder === 'cuda-nvenc' ? Math.min(2, requestedConcurrency) : requestedConcurrency
      let hardwareSegments = 0
      let fallbackSegments = 0
      let forceCpuAfterNvencFailure = false
      const transcodeAll = async (encoder, targetWorkDir) => {
        const segments = new Array(items.length)
        let cursor = 0
        const worker = async () => {
          while (!signal?.aborted) {
            const i = cursor
            cursor += 1
            if (i >= items.length) return
            const item = items[i]
            const segment = join(targetWorkDir, `seg-${String(i).padStart(3, '0')}.mp4`)
            const base = Math.round((i / items.length) * 90)
            const span = Math.round(90 / items.length)
            if (await segmentReady(segment, ffprobePath, item.media?.durationMs ?? 0)) {
              onProgress?.(base + span, `跳过已完成段 ${i + 1}/${items.length} · ${item.name}`)
              segments[i] = segment
              continue
            }
            const runSegment = async (segmentEncoder) =>
              runFfmpegImpl(
                ffmpegPath,
                buildTranscodeArgs(item.path, target, segment, {
                  encoder: segmentEncoder,
                  hasAudio: Boolean(item.media?.audioCodec)
                }),
                {
                  signal,
                  totalMs: item.media?.durationMs ?? 0,
                  onProgress: (pct) =>
                    onProgress?.(
                      base + Math.round((pct / 100) * span),
                      `转码统一 ${i + 1}/${items.length} · ${item.name} ${pct}%${
                        segmentEncoder === 'cuda-nvenc'
                          ? '（NVIDIA · 全 GPU 流水线）'
                          : segmentEncoder === 'nvenc'
                            ? '（NVIDIA 编码）'
                            : '（CPU）'
                      }`
                    )
                }
              )
            const effectiveEncoder = forceCpuAfterNvencFailure ? 'cpu' : encoder
            try {
              await runSegment(effectiveEncoder)
              if (effectiveEncoder === 'nvenc' || effectiveEncoder === 'cuda-nvenc')
                hardwareSegments += 1
            } catch (error) {
              // 完整 CUDA 路径含 NVDEC 与 CUDA 滤镜，报错文本并不总带 NVENC/CUDA 关键词；
              // 该可选路径一旦失败就按段无条件退回稳定的 CPU 滤镜 + NVENC，不让整任务中断。
              if (signal?.aborted || (encoder !== 'cuda-nvenc' && !isNvencRuntimeFailure(error)))
                throw error
              if (encoder === 'cuda-nvenc') {
                fallbackSegments += 1
                onProgress?.(
                  base,
                  `GPU 完整流水线不支持第 ${i + 1} 段，改用 NVIDIA 编码 + CPU 缩放`
                )
                await runSegment('nvenc')
                hardwareSegments += 1
              } else if (encoder === 'nvenc') {
                fallbackSegments += 1
                nvencFallbackReason = `实际转码时 NVIDIA NVENC 不可用：${
                  error instanceof Error ? error.message : String(error)
                }`
                // 默认串行模式在首个 NVENC 失败后不再反复尝试该设备，后续段都稳定使用 CPU。
                forceCpuAfterNvencFailure = true
                activeEncoder = 'cpu'
                onProgress?.(base, `第 ${i + 1} 段 NVIDIA 编码失败，后续统一使用 CPU x264`)
                await runSegment('cpu')
              } else {
                throw error
              }
            }
            segments[i] = segment
          }
          throw new Error('已取消')
        }
        await Promise.all(
          Array.from({ length: Math.min(transcodeConcurrency, items.length) }, worker)
        )
        return segments
      }
      const segments = await transcodeAll(activeEncoder, workDir)
      gpuSummary = {
        requested: nvencEnabled,
        encoder: compatibility.compatible ? 'copy' : activeEncoder === 'cpu' ? 'cpu' : 'nvenc',
        pipeline: compatibility.compatible
          ? 'copy'
          : cudaPipelineAvailable && fallbackSegments === 0
            ? 'cuda-nvenc'
            : activeEncoder === 'cpu'
              ? 'cpu'
              : 'nvenc',
        hardwareSegments,
        fallbackSegments,
        note:
          activeEncoder === 'cuda-nvenc'
            ? `完整 GPU 流水线完成 ${hardwareSegments} 段${fallbackSegments ? `，${fallbackSegments} 段已安全降级` : ''}`
            : activeEncoder === 'nvenc'
              ? `NVIDIA NVENC 编码完成 ${hardwareSegments} 段${fallbackSegments ? `，${fallbackSegments} 段已回退 CPU` : ''}`
              : '使用 CPU x264 编码'
      }
      try {
        await ensureOutputSpace()
      } catch (error) {
        await discardStagedFile(transactionPath).catch(() => {})
        return {
          cancelled: false,
          outputPath: null,
          verified: false,
          verifyNote: `拼接前检查失败：${error instanceof Error ? error.message : String(error)}`,
          transcoded: true,
          videoEncoder: activeEncoder,
          ...(nvencFallbackReason ? { nvencFallbackReason } : {})
        }
      }
      onProgress?.(92, '拼接中')
      const listPath = join(workDir, 'concat.txt')
      await writeTextFile(listPath, buildConcatList(segments))
      await runFfmpegImpl(ffmpegPath, buildConcatSegmentsArgs(listPath, stagingPath), {
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
      await discardStagedFile(transactionPath).catch(() => {})
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
    await writeAtomicTextFile(
      transactionPath,
      JSON.stringify({ ...transaction, state: 'prepared' })
    )
    if (!(await installStagedFileIfAbsent(stagingPath, outputPath))) {
      // 目标由其他进程创建：仅清理本次已校验暂存和日志，绝不触碰该目标文件。
      await discardStagedFile(stagingPath).catch(() => {})
      await discardStagedFile(transactionPath).catch(() => {})
      return {
        cancelled: false,
        outputPath: null,
        verified: false,
        verifyNote: '输出文件在合并期间被新建，已保留对方文件且未覆盖；请重新执行以生成新名称',
        transcoded: !compatibility.compatible,
        videoEncoder: compatibility.compatible ? 'copy' : activeEncoder,
        ...(nvencFallbackReason ? { nvencFallbackReason } : {})
      }
    }
    // 正式产物已无覆盖落位；后续 journal 更新失败不能把成功合并误报为失败。
    verified = true
    try {
      await writeAtomicTextFile(
        transactionPath,
        JSON.stringify({ ...transaction, state: 'installed' })
      )
      await discardStagedFile(transactionPath)
    } catch {
      transactionCleanupPending = true
    }
    onProgress?.(100, transactionCleanupPending ? '完成（恢复记录待清理）' : '完成')
    return {
      cancelled: false,
      outputPath,
      verified: true,
      verifyNote: `${verify.note}${
        !compatibility.compatible ? `（${gpuSummary.note}）` : ''
      }${transactionCleanupPending ? '（恢复记录将在下次扫描时清理）' : ''}`,
      transcoded: !compatibility.compatible,
      videoEncoder: compatibility.compatible
        ? 'copy'
        : activeEncoder === 'cuda-nvenc'
          ? 'nvenc'
          : activeEncoder,
      ...(nvencFallbackReason ? { nvencFallbackReason } : {}),
      gpuSummary,
      tempDirectory: workDir
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const cancelled = signal?.aborted || errorMessage === '已取消'
    await discardStagedFile(stagingPath).catch(() => {})
    await discardStagedFile(transactionPath).catch(() => {})
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
        videoEncoder: compatibility.compatible
          ? 'copy'
          : activeEncoder === 'cuda-nvenc'
            ? 'nvenc'
            : activeEncoder,
        ...(nvencFallbackReason ? { nvencFallbackReason } : {}),
        gpuSummary,
        tempDirectory: workDir
      }
    }
    const hardLinkUnsupported = error?.code === 'MSD_HARDLINK_UNSUPPORTED'
    return {
      cancelled: false,
      outputPath: null,
      verified: false,
      verifyNote: hardLinkUnsupported
        ? '合并失败：当前输出文件系统不支持安全的无覆盖提交，请将工作区移至 NTFS、APFS 或其他支持硬链接的文件系统'
        : '合并失败（已完成的转码段已保留，重新执行可续传）',
      transcoded: !compatibility.compatible,
      videoEncoder: compatibility.compatible
        ? 'copy'
        : activeEncoder === 'cuda-nvenc'
          ? 'nvenc'
          : activeEncoder,
      ...(nvencFallbackReason ? { nvencFallbackReason } : {}),
      gpuSummary,
      tempDirectory: workDir,
      error: errorMessage
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
