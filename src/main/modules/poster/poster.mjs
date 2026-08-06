import { createHash } from 'node:crypto'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { createScanPlan, posterFinalName } from '../../core/scanner.mjs'
import { captureFrame, buildFrameTimestamps, detectSceneCuts } from '../../core/frames.mjs'
import { probeMedia } from '../../core/probe.mjs'
import { convertToJpg } from '../../core/image.mjs'
import { permanentDelete } from '../../core/fs-ops.mjs'

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

/** 视频列表：复用只读扫描计划，附带现存 poster 信息。 */
export async function listPosterVideos(root) {
  const plan = await createScanPlan(root)
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
export async function captureCandidates(videoPath, framesRoot, { ffmpegPath, ffprobePath } = {}) {
  const outDir = framesDirFor(framesRoot, videoPath)
  let durationMs = 0
  try {
    const info = await probeMedia(videoPath, ffprobePath)
    durationMs = info.durationMs
  } catch {
    durationMs = 0
  }

  let timestamps = []
  if (durationMs > 1000) {
    try {
      timestamps = (await detectSceneCuts(videoPath, { ffmpegPath, limit: 5 })).filter(
        (t) => t * 1000 < durationMs - 200
      )
    } catch {
      timestamps = []
    }
    if (timestamps.length < 3) timestamps = buildFrameTimestamps(durationMs)
  } else {
    timestamps = [0]
  }
  const frames = []
  for (let i = 0; i < timestamps.length; i += 1) {
    const target = join(outDir, `candidate-${String(i + 1).padStart(2, '0')}.jpg`)
    frames.push(await captureFrame(videoPath, timestamps[i], target, ffmpegPath))
  }
  return frames
}

/** 在指定时间点精确截帧（用户在详情页拖动时间轴后手动选帧）。 */
export async function captureAt(videoPath, seconds, framesRoot, { ffmpegPath } = {}) {
  const outDir = framesDirFor(framesRoot, videoPath)
  const target = join(outDir, `manual-${Date.now()}.jpg`)
  return captureFrame(videoPath, Math.max(0, seconds), target, ffmpegPath)
}

/**
 * 保存选定封面：
 * 转 JPG 写入 <视频基名>-poster.jpg（覆盖旧 poster 位），删除旧关联图（若不同名），
 * 并清理该视频的临时候选目录。
 */
export async function savePoster({ videoPath, chosenFramePath, oldPosterPath }) {
  const dir = dirname(videoPath)
  const target = join(dir, posterFinalName(videoPath))
  const deletedOld = []

  // 选择的是"当前已保存封面"本身时无需任何写操作
  if (oldPosterPath && resolve(chosenFramePath) === resolve(oldPosterPath)) {
    return { saved: oldPosterPath, deletedOld }
  }

  await convertToJpg(chosenFramePath, target)
  if (oldPosterPath && resolve(oldPosterPath) !== resolve(target)) {
    await permanentDelete(oldPosterPath)
    deletedOld.push(oldPosterPath)
  }
  // 清理临时候选目录
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
