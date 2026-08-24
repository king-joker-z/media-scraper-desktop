import { createHash } from 'node:crypto'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { compareTitles } from '../../../shared/rename-rules.mjs'
import { createScanPlan, posterFinalName } from '../../core/scanner.mjs'
import {
  captureFrame,
  captureFrames,
  buildFrameTimestamps,
  detectSceneCuts
} from '../../core/frames.mjs'
import { probeMediaCached } from '../../core/probe.mjs'
import sharp from 'sharp'
import { convertToJpg, isJpegName } from '../../core/image.mjs'
import {
  computeDifferenceHash,
  groupSimilarHashes,
  hammingDistance
} from '../../../shared/visual-similarity.mjs'
import {
  commitStagedFile,
  copyFileSafe,
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
 * 检测不足 3 个或失败时回退到固定百分比时点。
 */
// 长视频不做场景切换检测：全片解码成本高（30 分钟视频几十秒），
// 直接用固定百分比时点；短视频才值得跑场景检测找内容突变帧
const SCENE_DETECT_MAX_DURATION_MS = 2 * 60 * 1000
const SCORE_WIDTH = 240
// 候选图即为最终封面：一次截取到位，确认时仅安全复制落盘，避免重复解码视频。
const PREVIEW_WIDTH = 1920
const PREVIEW_QUALITY = 2
const CANDIDATE_COUNT = 5
const FINAL_WIDTH = 1920
const SCORE_CONCURRENCY = 2
const BLACK_FRAME_RATIO = 0.98
const BLACK_FRAME_BRIGHTNESS = 12
const UNIFORM_FRAME_RATIO = 0.98
const UNIFORM_FRAME_DEVIATION = 10
const UNIFORM_FRAME_CONTRAST = 8

const timestampFromCandidatePath = (framePath) => {
  const match = basename(framePath).match(/-at-(\d+)ms\.jpg$/)
  return match ? Number(match[1]) / 1000 : null
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const lane = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane))
  return results
}

/**
 * 轻量候选帧质量评分：只解码 240px 灰度缩略图，不引入模型推理。
 * 清晰度使用相邻像素边缘能量；黑屏、纯白和近乎纯色背景均不参与自动推荐。
 */
export async function scoreCandidateFrame(framePath) {
  const { data, info } = await sharp(framePath)
    .resize({ width: SCORE_WIDTH, withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pixels = data.length
  if (!pixels) throw new Error('候选帧为空')
  let sum = 0
  let sumSquares = 0
  let dark = 0
  let edge = 0
  let edgeCount = 0
  for (let index = 0; index < pixels; index += 1) {
    const value = data[index]
    sum += value
    sumSquares += value * value
    if (value < 20) dark += 1
    if (index % info.width !== 0) {
      edge += Math.abs(value - data[index - 1])
      edgeCount += 1
    }
    if (index >= info.width) {
      edge += Math.abs(value - data[index - info.width])
      edgeCount += 1
    }
  }
  const brightness = sum / pixels
  const contrast = Math.sqrt(Math.max(0, sumSquares / pixels - brightness * brightness))
  const blackRatio = dark / pixels
  let uniform = 0
  for (const value of data) {
    if (Math.abs(value - brightness) <= UNIFORM_FRAME_DEVIATION) uniform += 1
  }
  const uniformRatio = uniform / pixels
  const clarity = edgeCount ? edge / edgeCount : 0
  // 亮度接近 128 更自然，纯色标题卡、淡入淡出与黑场都不适合作为自动封面。
  const exposure = Math.max(0, 1 - Math.abs(brightness - 128) / 128)
  const isBlack = blackRatio >= BLACK_FRAME_RATIO && brightness <= BLACK_FRAME_BRIGHTNESS
  const isUniform = uniformRatio >= UNIFORM_FRAME_RATIO && contrast <= UNIFORM_FRAME_CONTRAST
  // 拒绝项仍返回给用户手动选择，但永远沉底且不会成为默认封面。
  const rejected = isBlack || isUniform
  const hash = computeDifferenceHash(data, info.width, info.height)
  const score = rejected
    ? Number.NEGATIVE_INFINITY
    : clarity * 0.55 + contrast * 0.25 + exposure * 25 - blackRatio * 100
  return {
    path: framePath,
    score,
    brightness,
    contrast,
    clarity,
    blackRatio,
    uniformRatio,
    rejected,
    hash
  }
}

/** 为视觉相似候选分配组号；分组仅影响接触表浏览，不影响推荐、自动选择或保存。 */
export function assignSimilarityGroups(scores) {
  // 即使调用方未预先排序，也始终选质量最高的候选作为组代表帧。
  const orderedIndices = scores
    .map((_, index) => index)
    .sort((left, right) => (scores[right].score ?? 0) - (scores[left].score ?? 0) || left - right)
  const groups = groupSimilarHashes(orderedIndices.map((index) => scores[index].hash))
  const assignments = new Map()
  groups.forEach((members, groupIndex) => {
    const representative = orderedIndices[members[0]]
    for (const member of members) {
      const index = orderedIndices[member]
      assignments.set(index, {
        similarityGroup: groupIndex + 1,
        similarityDistance:
          index === representative
            ? 0
            : hammingDistance(scores[representative].hash, scores[index].hash)
      })
    }
  })
  return scores.map((entry, index) => ({ ...entry, ...assignments.get(index) }))
}

/** 对一批候选帧评分，返回稳定排序（同分按原始路径保证结果可复现）。 */
export async function rankCandidateFrames(framePaths) {
  const scored = await mapWithConcurrency(framePaths, SCORE_CONCURRENCY, async (path) => {
    try {
      return await scoreCandidateFrame(path)
    } catch {
      return {
        path,
        score: Number.NEGATIVE_INFINITY,
        brightness: 0,
        contrast: 0,
        clarity: 0,
        blackRatio: 1,
        uniformRatio: 1,
        rejected: true
      }
    }
  })
  return scored.sort(
    (left, right) => right.score - left.score || compareTitles(left.path, right.path)
  )
}

export async function captureCandidates(
  videoPath,
  framesRoot,
  { ffmpegPath, ffprobePath, signal, precise = false } = {}
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

  // 普通模式与精细模式都保留五张候选，保证人工挑选空间；
  // 精细模式仅对短视频额外进行场景切换检测。
  let timestamps = [0]
  const sceneCutTimestamps = new Set()
  if (durationMs > SCENE_DETECT_MAX_DURATION_MS || !precise) {
    timestamps = buildFrameTimestamps(durationMs, CANDIDATE_COUNT)
  } else if (durationMs > 1000) {
    try {
      timestamps = (await detectSceneCuts(videoPath, { ffmpegPath, limit: 5, signal })).filter(
        (t) => t * 1000 < durationMs - 200
      )
      timestamps.forEach((timestamp) => sceneCutTimestamps.add(Math.round(timestamp * 1000)))
    } catch {
      timestamps = []
    }
    // 场景检测常只返回少量切换点；补足固定比例时点，确保可选画面始终尽量达到五张。
    timestamps = [
      ...new Set([0, ...timestamps, ...buildFrameTimestamps(durationMs, CANDIDATE_COUNT)])
    ]
      .sort((left, right) => left - right)
      .slice(0, CANDIDATE_COUNT)
  }
  // 候选截帧使用精确 seek，使候选预览、播放器定位和最终保存始终对应同一画面。
  const jobs = timestamps.map((seconds, i) => ({
    seconds,
    target: join(
      outDir,
      `candidate-${String(i + 1).padStart(2, '0')}-at-${Math.round(seconds * 1000)}ms.jpg`
    )
  }))
  // 候选即最终封面，使用高质量限宽图，确认时无需重新从视频截帧。
  const frames = await captureFrames(videoPath, jobs, ffmpegPath, {
    signal,
    fast: false,
    width: PREVIEW_WIDTH,
    quality: PREVIEW_QUALITY
  })
  const ranked = await rankCandidateFrames(frames)
  // 质量排序决定默认推荐。不能强行置顶首帧，否则纯色片头可能覆盖真正优质画面。
  const maxScore = ranked[0]?.score
  const minScore = ranked.at(-1)?.score
  const range = maxScore - minScore
  const scored = ranked.map((entry) => {
    const timestampMs = Math.round((timestampFromCandidatePath(entry.path) ?? 0) * 1000)
    return {
      ...entry,
      timestampMs,
      sceneCut: sceneCutTimestamps.has(timestampMs),
      // 将原始质量分映射到 0-100，仅用于同一视频候选间的可视化比较。
      score: Number.isFinite(entry.score)
        ? range > 0
          ? ((entry.score - minScore) / range) * 100
          : 100
        : 0
    }
  })
  return assignSimilarityGroups(scored).map((entry) => {
    const result = { ...entry }
    delete result.hash
    return result
  })
}

/** 在指定时间点精确截帧（用户在详情页拖动时间轴后手动选帧）。 */
export async function captureAt(videoPath, seconds, framesRoot, { ffmpegPath, signal } = {}) {
  const outDir = framesDirFor(framesRoot, videoPath)
  // 毫秒 + 随机后缀，避免同一毫秒内连续手动截帧互相覆盖
  const target = join(outDir, `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`)
  return captureFrame(videoPath, Math.max(0, seconds), target, ffmpegPath, {
    signal,
    width: FINAL_WIDTH,
    quality: 2
  })
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
  deleteFn = permanentDelete,
  signal
}) {
  const dir = dirname(videoPath)
  const target = join(dir, posterFinalName(videoPath))
  const deletedOld = []

  // 选择的是"当前已保存封面"本身时无需任何写操作
  if (oldPosterPath && resolve(chosenFramePath) === resolve(oldPosterPath)) {
    return { saved: oldPosterPath, deletedOld }
  }

  // 先转到同目录暂存文件，验证生成成功后再安全替换，规避 Windows 文件锁导致旧封面丢失。
  // 转码本身不可中断，但取消后绝不继续提交、删除旧封面或清理候选帧。
  if (signal?.aborted) throw new Error('已取消')
  const stagingPath = createStagingPath(target)
  const candidateSeconds = timestampFromCandidatePath(chosenFramePath)
  try {
    if (candidateSeconds !== null || isJpegName(chosenFramePath)) {
      // 候选和手动截图均已是最终质量的 JPG，直接暂存复制并安全提交。
      await copyFileSafe(chosenFramePath, stagingPath)
    } else {
      await convertToJpg(chosenFramePath, stagingPath)
    }
    if (signal?.aborted) throw new Error('已取消')
    await commitStagedFile(stagingPath, target)
  } catch (error) {
    await discardStagedFile(stagingPath)
    throw error
  }
  if (signal?.aborted) return { saved: target, deletedOld }
  if (oldPosterPath && resolve(oldPosterPath) !== resolve(target)) {
    await deleteFn(oldPosterPath)
    deletedOld.push(oldPosterPath)
  }
  // 仅清理应用生成的候选/手动截帧目录；工作区中的既有 JPG 不能误删其父目录。
  const frameName = basename(chosenFramePath)
  const isGeneratedFrame =
    candidateSeconds !== null ||
    frameName.startsWith('manual-') ||
    frameName.startsWith('candidate')
  if (!signal?.aborted && isGeneratedFrame) await permanentDelete(dirname(chosenFramePath))
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
