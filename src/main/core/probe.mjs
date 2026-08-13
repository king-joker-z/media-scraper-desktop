import { stat } from 'node:fs/promises'
import ffprobeStatic from 'ffprobe-static'
import { runPooled } from './ffmpeg-pool.mjs'
import { createLruCache } from './lru-cache.mjs'

/**
 * ffprobe 二进制路径：开发时来自 node_modules；
 * 打包后二进制在 app.asar.unpacked 中（electron-builder asarUnpack 配置）。
 */
export function resolveFfprobePath() {
  // ffprobe-static 当前不会提供 Windows ARM64 可执行文件；即使解析到 x64 路径，
  // 在未安装 x64 仿真组件的设备上只会得到难以理解的 ENOEXEC/UNKNOWN 错误。
  if (process.platform === 'win32' && process.arch === 'arm64') {
    throw new Error(
      '当前随应用分发的 FFprobe 不支持 Windows ARM64，请安装 x64 版本运行，或等待 ARM64 二进制支持。'
    )
  }
  const raw = typeof ffprobeStatic === 'string' ? ffprobeStatic : ffprobeStatic?.path
  if (!raw) throw new Error('未找到随应用分发的 FFprobe 二进制，请重新安装应用。')
  return raw.replace('app.asar', 'app.asar.unpacked')
}

/** 解析 r_frame_rate（如 "30000/1001"）为数值 fps。 */
export function parseFrameRate(rate) {
  if (!rate) return 0
  const [numerator, denominator] = String(rate).split('/').map(Number)
  if (!Number.isFinite(numerator)) return 0
  if (!Number.isFinite(denominator) || denominator === 0) return numerator
  return numerator / denominator
}

/** 读取旋转元数据（tags.rotate 或 side_data rotation）。 */
function readRotation(videoStream) {
  const fromTag = Number(videoStream?.tags?.rotate)
  if (Number.isFinite(fromTag) && fromTag !== 0) return fromTag
  const sideData = Array.isArray(videoStream?.side_data_list) ? videoStream.side_data_list : []
  for (const entry of sideData) {
    const value = Number(entry?.rotation)
    if (Number.isFinite(value) && value !== 0) return value
  }
  return 0
}

/**
 * 将 ffprobe -show_format -show_streams 的 JSON 输出归一化为 MediaInfo。
 * 纯函数，可单测。旋转 90/270 时宽高互换后再判定横竖屏。
 */
export function parseProbeJson(raw) {
  const format = raw?.format ?? {}
  const streams = Array.isArray(raw?.streams) ? raw.streams : []
  const video = streams.find((s) => s?.codec_type === 'video')
  const audio = streams.find((s) => s?.codec_type === 'audio')

  const rawWidth = Number(video?.width ?? 0)
  const rawHeight = Number(video?.height ?? 0)
  const rotation = Math.abs(readRotation(video))
  const swapped = rotation === 90 || rotation === 270
  const width = swapped ? rawHeight : rawWidth
  const height = swapped ? rawWidth : rawHeight

  return {
    container: String(format.format_name ?? ''),
    durationMs: Math.round(Number(format.duration ?? 0) * 1000),
    sizeBytes: Number(format.size ?? 0),
    width,
    height,
    orientation: width >= height ? 'landscape' : 'portrait',
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    fps: parseFrameRate(video?.r_frame_rate),
    pixFmt: video?.pix_fmt ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    channels: audio?.channels ? Number(audio.channels) : null
  }
}

/**
 * 探测单个媒体文件。失败抛出带文件路径的错误，由任务中心收集。
 */
export async function probeMedia(filePath, ffprobePath = resolveFfprobePath()) {
  const { stdout } = await runPooled(ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath
  ])
  return parseProbeJson(JSON.parse(stdout))
}

/* ---------------- 探测缓存：按 path+mtime+size 命中，避免重复探测 ---------------- */

// LRU 淘汰（最多 2000 条）：只淘汰最久未用条目，替代原先超限全清（热点条目被误清）
const PROBE_CACHE_MAX = 2000
const probeCache = createLruCache(PROBE_CACHE_MAX)

/**
 * 带缓存的探测：文件未变化（mtime/size 相同）直接返回缓存。
 * probeFn 可注入便于测试。
 */
export async function probeMediaCached(
  filePath,
  ffprobePath = resolveFfprobePath(),
  probeFn = probeMedia
) {
  const info = await stat(filePath)
  const key = `${filePath}:${info.mtimeMs}:${info.size}`
  const cached = probeCache.get(key)
  if (cached) return cached
  const result = await probeFn(filePath, ffprobePath)
  probeCache.set(key, result)
  return result
}

export function clearProbeCache() {
  probeCache.clear()
}
