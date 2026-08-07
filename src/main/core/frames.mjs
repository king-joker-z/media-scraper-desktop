import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { pathExists } from './fs-ops.mjs'

const execFileAsync = promisify(execFile)

/** ffmpeg 二进制路径：打包后位于 app.asar.unpacked（asarUnpack 配置） */
export function resolveFfmpegPath() {
  return String(ffmpegStatic).replace('app.asar', 'app.asar.unpacked')
}

/** 默认 5 个候选截帧时点（冻结稿 §6：10/30/50/70/90%），返回秒数组 */
export function buildFrameTimestamps(durationMs, count = 5) {
  const ratios = [0.1, 0.3, 0.5, 0.7, 0.9].slice(0, Math.max(1, count))
  return ratios.map((ratio) => Math.max(0, Math.round(durationMs * ratio) / 1000))
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
    "scale='min(1920,iw)':-2",
    '-y',
    targetPath
  )
  return args
}

/**
 * 场景切换检测：低分辨率快速解码全片，select 滤镜筛出内容突变帧，
 * 经 showinfo 输出时间戳。返回秒数组（按出现顺序）。
 * -skip_frame nokey 只解码关键帧（场景切换通常落在关键帧上），长视频提速显著；
 * -an -sn -dn 跳过音频/字幕/数据流，避免无谓解码。
 */
export async function detectSceneCuts(
  videoPath,
  { ffmpegPath = resolveFfmpegPath(), threshold = 0.4, limit = 8 } = {}
) {
  const { stderr } = await execFileAsync(
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
    { maxBuffer: 64 * 1024 * 1024 }
  )
  const times = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((match) => Number(match[1]))
  return times.slice(0, limit)
}

/** 截取单帧为 JPG；失败（无输出文件）抛错。 */
export async function captureFrame(
  videoPath,
  seconds,
  targetPath,
  ffmpegPath = resolveFfmpegPath()
) {
  await mkdir(dirname(targetPath), { recursive: true })
  await execFileAsync(ffmpegPath, buildCaptureArgs(videoPath, seconds, targetPath))
  if (!(await pathExists(targetPath))) {
    throw new Error(`截帧未生成图片（${seconds}s）：${videoPath}`)
  }
  return targetPath
}
