import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { pathExists } from './fs-ops.mjs'
import { runPooled } from './ffmpeg-pool.mjs'

/** ffmpeg 二进制路径：打包后位于 app.asar.unpacked（asarUnpack 配置） */
export function resolveFfmpegPath() {
  if (!ffmpegStatic) {
    const unsupportedArm = process.platform === 'win32' && process.arch === 'arm64'
    throw new Error(
      unsupportedArm
        ? '当前随应用分发的 FFmpeg 不支持 Windows ARM64，请安装 x64 版本运行，或等待 ARM64 二进制支持。'
        : '未找到随应用分发的 FFmpeg 二进制，请重新安装应用。'
    )
  }
  return String(ffmpegStatic).replace('app.asar', 'app.asar.unpacked')
}

/** 默认 5 个候选截帧时点：首帧 + 25/50/75/90%，返回秒数组。 */
export function buildFrameTimestamps(durationMs, count = 5) {
  const ratios = [0, 0.25, 0.5, 0.75, 0.9].slice(0, Math.max(1, count))
  return ratios.map((ratio) => Math.max(0, Math.round(durationMs * ratio) / 1000))
}

/**
 * 快速截帧参数：仅输入侧 -ss（关键帧级定位，几乎零解码）。
 * 用于候选封面等对帧精度不敏感的场景——几十分钟的长视频也能亚秒出图。
 */
export function buildFastCaptureArgs(videoPath, seconds, targetPath) {
  return [
    '-v',
    'error',
    '-ss',
    String(Math.max(0, seconds)),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-vf',
    'scale=w=min(1920\\,iw):h=-2',
    '-y',
    targetPath
  ]
}

/**
 * 构造截帧参数：两段式 seek——先快速跳到目标前 10 秒再精确解码，
 * 兼顾长视频速度与帧精确度；输出限宽 1920 防止超大帧撑爆内存。
 */
export function buildCaptureArgs(videoPath, seconds, targetPath) {
  const args = ['-v', 'error']
  let accurateSeek = seconds
  if (seconds > 10) {
    args.push('-ss', String(seconds - 10))
    accurateSeek = 10
  }
  args.push(
    '-i',
    videoPath,
    '-ss',
    String(accurateSeek),
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-vf',
    'scale=w=min(1920\\,iw):h=-2',
    '-y',
    targetPath
  )
  return args
}

/**
 * 单进程多帧截取参数：每个时点一组「-ss <t> -i <视频>」输入（输入侧快速 seek），
 * 再逐个 -map 输出单帧 JPG。一次进程完成全部候选帧——进程创建与启动开销
 * （Windows 上尤其明显）从 N 次降为 1 次，多个输入在进程内并行解码。
 * @param {Array<{seconds: number, target: string}>} jobs
 */
export function buildMultiCaptureArgs(videoPath, jobs) {
  const args = ['-v', 'error']
  for (const job of jobs) {
    args.push('-ss', String(Math.max(0, job.seconds)), '-i', videoPath)
  }
  jobs.forEach((job, index) => {
    args.push(
      '-map',
      `${index}:v`,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-vf',
      'scale=w=min(1920\\,iw):h=-2',
      '-y',
      job.target
    )
  })
  return args
}

/**
 * 单进程批量截帧：返回成功生成的帧路径（越过末尾/损坏时点产生的缺帧被容忍剔除）；
 * 一帧都没产出才抛错。支持 AbortSignal 取消。
 */
export async function captureFrames(
  videoPath,
  jobs,
  ffmpegPath = resolveFfmpegPath(),
  { signal } = {}
) {
  if (jobs.length === 0) return []
  await mkdir(dirname(jobs[0].target), { recursive: true })
  await runPooled(ffmpegPath, buildMultiCaptureArgs(videoPath, jobs), { signal })
  const frames = []
  for (const job of jobs) {
    if (await pathExists(job.target)) frames.push(job.target)
  }
  if (frames.length === 0) {
    throw new Error(`截帧未生成任何图片：${videoPath}`)
  }
  return frames
}

/**
 * 场景切换检测：低分辨率快速解码全片，select 滤镜筛出内容突变帧，
 * 经 showinfo 输出时间戳。返回秒数组（按出现顺序）。
 * -skip_frame nokey 只解码关键帧（场景切换通常落在关键帧上），长视频提速显著；
 * -an -sn -dn 跳过音频/字幕/数据流，避免无谓解码。
 */
export async function detectSceneCuts(
  videoPath,
  { ffmpegPath = resolveFfmpegPath(), threshold = 0.4, limit = 8, signal } = {}
) {
  // execManaged：进程注册管理，退出即释放句柄；大 stderr 有 maxBuffer 保护；signal 可取消
  const { stderr } = await runPooled(
    ffmpegPath,
    [
      '-v',
      'info',
      '-skip_frame',
      'nokey',
      '-an',
      '-sn',
      '-dn',
      '-i',
      videoPath,
      '-vf',
      `scale=320:-2,select='gt(scene,${threshold})',showinfo`,
      '-f',
      'null',
      '-'
    ],
    { maxBuffer: 64 * 1024 * 1024, signal }
  )
  const times = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((match) => Number(match[1]))
  return times.slice(0, limit)
}

/**
 * 截取单帧为 JPG；失败（无输出文件）抛错。支持 AbortSignal 取消。
 * fast=true 用快速 seek（候选封面批量生成）；默认两段式精确 seek（用户手动选帧）。
 */
export async function captureFrame(
  videoPath,
  seconds,
  targetPath,
  ffmpegPath = resolveFfmpegPath(),
  { signal, fast = false } = {}
) {
  await mkdir(dirname(targetPath), { recursive: true })
  const args = fast
    ? buildFastCaptureArgs(videoPath, seconds, targetPath)
    : buildCaptureArgs(videoPath, seconds, targetPath)
  await runPooled(ffmpegPath, args, { signal })
  if (!(await pathExists(targetPath))) {
    throw new Error(`截帧未生成图片（${seconds}s）：${videoPath}`)
  }
  return targetPath
}
