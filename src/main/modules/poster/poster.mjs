import { createHash } from 'node:crypto'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { createScanPlan, posterFinalName } from '../../core/scanner.mjs'
import {
  captureFrame,
  captureFrames,
  buildFrameTimestamps,
  detectSceneCuts
} from '../../core/frames.mjs'
import { probeMediaCached } from '../../core/probe.mjs'
import { convertToJpg } from '../../core/image.mjs'
import {
  commitStagedFile,
  createStagingPath,
  discardStagedFile,
  permanentDelete
} from '../../core/fs-ops.mjs'

/**
 * 从扫描计划映射视频与现存 poster 的对应关系（纯函数，可单测）。
 */
export function mapPosterVideos(plan) {
  const posterByVideo = new Map()
  for (const item of plan.keep) {
    if (item.kind === 'image' && item.posterFor) {
      posterByVideo.set(item.posterFor, item.path)
    }
  }
  return plan.keep
    .filter((item) => item.kind === 'video')
    .map((video) => {
      const posterPath = posterByVideo.get(video.relativePath) ?? null
      return {
        path: video.path,
        relativePath: video.relativePath,
        name: video.name,
        size: video.size,
        posterPath,
        posterRelativePath: posterPath ? relativeOf(plan.root, posterPath) : null
      }
    })
}

const relativeOf = (root, absolute) => absolute.slice(root.length + 1)

/** 视频列表：复用只读扫描计划（带指纹缓存），附带现存 poster 信息。 */
export async function listPosterVideos(root, { onProgress, concurrency } = {}) {
  const plan = await createScanPlan(root, { onProgress, concurrency })
  return mapPosterVideos(plan)
}

/** 每个视频的候选帧临时目录（按路径 hash，避免冲突） */
export function framesDirFor(framesRoot, videoPath) {
  const hash = createHash('md5').update(videoPath).digest('hex').slice(0, 12)
  return join(framesRoot, hash)
}

/**
 * 为一个视频截取候选帧：
 * 优先用场景切换检测找内容突变帧（更可能是有信息的画面）；
 * 检测不足 3 个或失败时回退到固定百分比（10/30/50/70/90%）。
 */
// 长视频不做场景切换检测：全片解码成本高（30 分钟视频几十秒），
// 直接用固定百分比时点；短视频才值得跑场景检测找内容突变帧
const SCENE_DETECT_MAX_DURATION_MS = 2 * 60 * 1000

export async function captureCandidates(
  videoPath,
  framesRoot,
  { ffmpegPath, ffprobePath, signal } = {}
) {
  const outDir = framesDirFor(framesRoot, videoPath)
  let durationMs = 0
  try {
    // 命中探测缓存（合并/媒体库模块已探测过的文件无需再次 ffprobe）
    const info = await probeMediaCached(videoPath, ffprobePath)
    durationMs = info.durationMs
  } catch {
    durationMs = 0
  }

  let timestamps = []
  if (durationMs > SCENE_DETECT_MAX_DURATION_MS) {
    timestamps = buildFrameTimestamps(durationMs)
  } else if (durationMs > 1000) {
    try {
      timestamps = (await detectSceneCuts(videoPath, { ffmpegPath, limit: 5, signal })).filter(
        (t) => t * 1000 < durationMs - 200
      )
    } catch {
      timestamps = []
    }
    if (timestamps.length < 3) timestamps = buildFrameTimestamps(durationMs)
  } else {
    timestamps = [0]
  }
  // 单进程批量截帧：一次 ffmpeg 调用完成全部时点（输入侧快速 seek + 进程内并行解码），
  // 进程创建开销从 N 次降为 1 次；缺帧时点被容忍剔除，全部失败才抛错
  const jobs = timestamps.map((seconds, i) => ({
    seconds,
    target: join(outDir, `candidate-${String(i + 1).padStart(2, '0')}.jpg`)
  }))
  return captureFrames(videoPath, jobs, ffmpegPath, { signal })
}

/** 在指定时间点精确截帧（用户在详情页拖动时间轴后手动选帧）。 */
export async function captureAt(videoPath, seconds, framesRoot, { ffmpegPath, signal } = {}) {
  const outDir = framesDirFor(framesRoot, videoPath)
  // 毫秒 + 随机后缀，避免同一毫秒内连续手动截帧互相覆盖
  const target = join(outDir, `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`)
  return captureFrame(videoPath, Math.max(0, seconds), target, ffmpegPath, { signal })
}

/**
 * 保存选定封面：
 * 转 JPG 写入 <视频基名>-poster.jpg（覆盖旧 poster 位），删除旧关联图（若不同名），
 * 并清理该视频的临时候选目录。
 */
export async function savePoster({
  videoPath,
  chosenFramePath,
  oldPosterPath,
  deleteFn = permanentDelete
}) {
  const dir = dirname(videoPath)
  const target = join(dir, posterFinalName(videoPath))
  const deletedOld = []

  // 选择的是"当前已保存封面"本身时无需任何写操作
  if (oldPosterPath && resolve(chosenFramePath) === resolve(oldPosterPath)) {
    return { saved: oldPosterPath, deletedOld }
  }

  // 先转到同目录暂存文件，验证生成成功后再安全替换，规避 Windows 文件锁导致旧封面丢失。
  const stagingPath = createStagingPath(target)
  try {
    await convertToJpg(chosenFramePath, stagingPath)
    await commitStagedFile(stagingPath, target)
  } catch (error) {
    await discardStagedFile(stagingPath)
    throw error
  }
  if (oldPosterPath && resolve(oldPosterPath) !== resolve(target)) {
    await deleteFn(oldPosterPath)
    deletedOld.push(oldPosterPath)
  }
  // 候选帧为应用缓存，写入成功后可安全永久清理。
  await permanentDelete(dirname(chosenFramePath))
  return { saved: target, deletedOld }
}

/**
 * 计算待保存清单（纯函数）：选择项与现存 poster 不一致的视频需要落盘。
 * @param {Array} videos PosterVideoItem 列表
 * @param {Record<string, string>} selections relativePath -> 选中的帧/poster 路径
 */
export function computePendingSaves(videos, selections) {
  return videos
    .filter((video) => {
      const selected = selections[video.relativePath]
      return selected && selected !== video.posterPath
    })
    .map((video) => ({
      relativePath: video.relativePath,
      videoPath: video.path,
      chosenFramePath: selections[video.relativePath],
      oldPosterPath: video.posterPath
    }))
}

/** 清理指定视频或全部临时候选目录。 */
export async function cleanupFrames(framesRoot, videoPath) {
  await permanentDelete(videoPath ? framesDirFor(framesRoot, videoPath) : framesRoot)
}

export const videoStem = (videoPath) => basename(videoPath, extname(videoPath))
