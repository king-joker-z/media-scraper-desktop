import { basename, extname } from 'node:path'
import { createScanPlan } from '../../core/scanner.mjs'
import { resolveFfmpegPath } from '../../core/frames.mjs'
import { spawnPooled } from '../../core/ffmpeg-pool.mjs'

/**
 * 视频完整性体检（冻结稿外新增模块）：
 * - 损坏检测：ffmpeg 全量解码（-v error -f null -），解码报错即判损坏；
 * - 整理度统计：缺 poster / 缺 NFO / 体积分布；
 * 全程只读，不写任何文件。
 */

/** 单文件全量解码校验；stderr 截断保留尾部（最相关的错误在末尾） */
export async function checkVideoIntegrity(filePath, ffmpegPath, signal) {
  let stderrTail = ''
  const { code, cancelled } = await spawnPooled(
    ffmpegPath,
    ['-v', 'error', '-xerror', '-i', filePath, '-f', 'null', '-'],
    {
      signal,
      onStderr: (text) => {
        stderrTail = (stderrTail + text).slice(-4000)
      }
    }
  ).catch((error) => ({ code: null, cancelled: false, spawnError: error.message }))
  if (cancelled || signal?.aborted) return { ok: false, error: '已取消', cancelled: true }
  const detail = stderrTail.trim()
  if (code === 0 && !detail) return { ok: true }
  return {
    ok: false,
    error: detail.slice(0, 500) || (code === null ? `无法启动 ffmpeg` : `ffmpeg 退出码 ${code}`)
  }
}

const TOP_LARGEST = 10

/**
 * 体检扫描。
 * @param {string} root 工作区
 * @param {object} [options] { taskCenter, taskId, concurrency, ffmpegPath }
 * @returns {Promise<import('../../../shared/types').HealthReport>}（仅注释，运行时不依赖 ts）
 */
export async function healthScan(
  root,
  { taskCenter, taskId, concurrency = 5, ffmpegPath = resolveFfmpegPath() } = {}
) {
  const startedAt = Date.now()
  const plan = await createScanPlan(root)
  const videos = plan.keep.filter((item) => item.kind === 'video')

  // 现存 poster（keep 中 posterFor 指向视频）与 NFO（deleteItems 中的 .nfo 同名匹配）
  const posterFor = new Set(
    plan.keep
      .filter((item) => item.kind === 'image' && item.posterFor)
      .map((item) => item.posterFor)
  )
  const nfoNames = new Set(
    plan.deleteItems
      .filter((item) => extname(item.name).toLowerCase() === '.nfo')
      .map((item) => `${item.dir}/${basename(item.name, extname(item.name))}`.toLowerCase())
  )

  const corrupted = []
  const missingPoster = []
  const missingNfo = []
  let cancelled = false

  const worker = async (video, signal) => {
    const result = await checkVideoIntegrity(video.path, ffmpegPath, signal)
    if (result.cancelled) return
    if (!result.ok) corrupted.push({ relativePath: video.relativePath, error: result.error })
    if (!posterFor.has(video.relativePath)) missingPoster.push(video.relativePath)
    const stemKey = `${video.dir}/${basename(video.name, extname(video.name))}`.toLowerCase()
    if (!nfoNames.has(stemKey)) missingNfo.push(video.relativePath)
  }

  let checked = 0
  if (taskCenter) {
    const result = await taskCenter.run({
      taskId,
      label: '视频完整性体检',
      items: videos,
      concurrency,
      worker
    })
    cancelled = result.cancelled
    checked = result.completed + result.failed
  } else {
    for (const video of videos) await worker(video, undefined)
    checked = videos.length
  }

  const bySizeDesc = [...videos].sort((a, b) => b.size - a.size)
  return {
    taskId: taskId ?? null,
    cancelled,
    total: videos.length,
    checked,
    corrupted,
    missingPoster,
    missingNfo,
    totalBytes: videos.reduce((sum, video) => sum + video.size, 0),
    largest: bySizeDesc.slice(0, TOP_LARGEST).map((video) => ({
      relativePath: video.relativePath,
      size: video.size
    })),
    durationMs: Date.now() - startedAt
  }
}
