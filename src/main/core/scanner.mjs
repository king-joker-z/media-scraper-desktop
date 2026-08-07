import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'

export const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.m4v',
  '.mkv',
  '.avi',
  '.mov',
  '.wmv',
  '.webm',
  '.flv',
  '.ts',
  '.m2ts',
  '.mpeg',
  '.mpg',
  '.3gp'
])
export const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.bmp',
  '.avif',
  '.gif',
  '.tif',
  '.tiff'
])

export const isHiddenName = (name) => name.startsWith('.')

export const classifyPath = (path) => {
  const extension = extname(path).toLowerCase()
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return 'other'
}

/**
 * 归一化匹配名：去扩展名、小写、去 -poster 后缀、去空格（含全角）/._-
 * 注意：按冻结稿 §3，不清除年份、分辨率、版本、CD 分段等语义片段。
 */
export const normalizedName = (path) =>
  basename(path, extname(path))
    .toLowerCase()
    .replace(/-poster$/i, '')
    .replace(/[\s._-]+/g, '')

const stemOf = (name) => basename(name, extname(name)).toLowerCase()
const hasPosterSuffix = (name) => /-poster$/i.test(stemOf(name))

/** poster 标准化目标名：<视频基名>-poster.jpg（冻结稿 §3） */
export const posterFinalName = (videoRelativePath) => {
  const ext = extname(videoRelativePath)
  return `${basename(videoRelativePath, ext)}-poster.jpg`
}

/** 危险阈值：删除条数或总体积超过即需确认词二次确认（冻结稿 §2.6） */
export const DANGER_DELETE_COUNT = 50
export const DANGER_DELETE_BYTES = 1024 * 1024 * 1024

export function assessRisk(deleteItems, videoCount) {
  const deleteBytes = deleteItems.reduce((sum, item) => sum + item.size, 0)
  const danger =
    deleteItems.length > DANGER_DELETE_COUNT ||
    deleteBytes > DANGER_DELETE_BYTES ||
    (videoCount === 0 && deleteItems.length > 0)
  return { risk: danger ? 'danger' : 'normal', deleteBytes }
}

/**
 * 上移重名预测（冻结稿 §2.7 预览可见）：
 * 占用者 = 根目录保留项 + 根目录隐藏项；子目录项按路径排序后依次占位，
 * 冲突时追加 " (n)"。执行层仍会二次兼底。
 */
export function predictMoves(keep, skippedHidden) {
  const taken = new Set()
  for (const item of keep) {
    if (item.dir === '.') taken.add((item.finalName ?? item.name).toLowerCase())
  }
  for (const rel of skippedHidden) {
    if (dirname(rel) === '.') taken.add(basename(rel).toLowerCase())
  }
  const moves = []
  const sorted = keep
    .filter((item) => item.dir !== '.')
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  for (const item of sorted) {
    const desired = item.finalName ?? item.name
    let target = desired
    let renamed = false
    if (taken.has(target.toLowerCase())) {
      const ext = extname(desired)
      const stem = basename(desired, ext)
      let n = 1
      while (taken.has(`${stem} (${n})${ext}`.toLowerCase())) n += 1
      target = `${stem} (${n})${ext}`
      renamed = true
    }
    taken.add(target.toLowerCase())
    moves.push({ from: item.relativePath, to: target, renamed })
  }
  return moves
}

// 目录遍历并发批大小：stat 是 I/O 操作，并发批处理可显著加速大目录扫描
const WALK_BATCH = 32

// 每发现多少个文件上报一次进度（供大目录扫描的进度反馈）
const PROGRESS_EVERY = 200

async function walk(root, current, records, skipped, state) {
  const entries = await readdir(current, { withFileTypes: true })
  for (let i = 0; i < entries.length; i += WALK_BATCH) {
    const batch = entries.slice(i, i + WALK_BATCH)
    await Promise.all(
      batch.map(async (entry) => {
        const fullPath = join(current, entry.name)
        if (isHiddenName(entry.name)) {
          skipped.push(relative(root, fullPath))
          return
        }
        if (entry.isDirectory()) {
          await walk(root, fullPath, records, skipped, state)
          return
        }
        if (!entry.isFile()) return
        try {
          const info = await stat(fullPath)
          const relativePath = relative(root, fullPath)
          records.push({
            path: fullPath,
            relativePath,
            dir: dirname(relativePath),
            name: entry.name,
            kind: classifyPath(fullPath),
            size: info.size,
            mtimeMs: info.mtimeMs
          })
          state.scanned += 1
          if (state.scanned % PROGRESS_EVERY === 0) state.onProgress?.(state.scanned)
        } catch {
          // 无权限/已消失的文件跳过，不中断整体扫描
        }
      })
    )
  }
}

/** 单次全量遍历：产出文件记录与隐藏项；onProgress(已发现文件数) 可选 */
async function walkWorkspace(root, onProgress) {
  const records = []
  const skipped = []
  await walk(root, root, records, skipped, { scanned: 0, onProgress })
  return { records, skippedHidden: skipped }
}

/* ---------------- 扫描缓存：指纹与计划共享同一次遍历 ---------------- */

// computeFingerprint 暂存的遍历结果有效期：页面激活时「算指纹 → 触发扫描」间隔为毫秒级，
// 超过 TTL 的暂存视为过期（文件可能已变化），重新遍历。
const STASH_TTL_MS = 5000

let lastWalk = null // { root, at, fingerprint, records, skippedHidden }

// root -> { fingerprint, plan }：指纹未变的重复扫描直接复用计划，各模块共享同一份结果
const planCache = new Map()
const PLAN_CACHE_MAX = 8

const fingerprintOf = (records) => {
  const hash = createHash('md5')
  for (const record of records.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(`${record.relativePath}:${record.size}:${record.mtimeMs}\n`)
  }
  return hash.digest('hex')
}

/**
 * 工作区内容指纹：递归文件（相对路径+大小+mtime）排序后的 MD5。
 * 任何文件增删改名/内容变化都会改变指纹；隐藏项不参与（与扫描口径一致）。
 * 用于页面切换时的“无变化不重扫”判定。
 * 遍历结果会短暂暂存：紧随其后的 createScanPlan 直接复用，不再二次遍历。
 */
export async function computeFingerprint(root, { onProgress } = {}) {
  const { records, skippedHidden } = await walkWorkspace(root, onProgress)
  const fingerprint = fingerprintOf(records)
  lastWalk = { root, at: Date.now(), fingerprint, records, skippedHidden }
  return fingerprint
}

/** 强制刷新与测试用：清空扫描缓存 */
export function invalidateScanCache() {
  lastWalk = null
  planCache.clear()
}

/**
 * 生成只读扫描计划（绝不写文件系统）。
 * 规则（冻结稿 §3）：
 * - 仅同层目录匹配；
 * - 一图多视频 → 歧义删除 + 冲突；
 * - 一视频多图 → -poster 优先 → 完全同名次之 → 否则进入 pendingPick 待人工手选；
 * - 其他文件一律删除候选；
 * - 保留项在子目录中的生成上移预览（跨平台：以 dirname 判断而非字符串 '/'）。
 */
export async function createScanPlan(root, { onProgress } = {}) {
  let records
  let skippedHidden
  let fingerprint
  if (lastWalk && lastWalk.root === root && Date.now() - lastWalk.at < STASH_TTL_MS) {
    // 复用指纹计算时的遍历结果，省掉一次全量递归
    ;({ records, skippedHidden, fingerprint } = lastWalk)
  } else {
    const walked = await walkWorkspace(root, onProgress)
    records = walked.records
    skippedHidden = walked.skippedHidden
    fingerprint = fingerprintOf(records)
  }
  lastWalk = null

  const cached = planCache.get(root)
  if (cached && cached.fingerprint === fingerprint) return cached.plan

  const byDir = new Map()
  for (const record of records) {
    if (!byDir.has(record.dir)) byDir.set(record.dir, [])
    byDir.get(record.dir).push(record)
  }

  const keep = []
  const deleteItems = []
  const conflicts = []
  const pendingPick = []
  let videoCount = 0
  let imageCount = 0
  let otherCount = 0

  for (const bucket of byDir.values()) {
    const videos = bucket.filter((item) => item.kind === 'video')
    const images = bucket.filter((item) => item.kind === 'image')
    const others = bucket.filter((item) => item.kind === 'other')
    videoCount += videos.length
    imageCount += images.length
    otherCount += others.length

    for (const other of others) deleteItems.push({ ...other, reason: '非视频/图片文件' })

    // 视频 -> 同层归一化同名图片候选
    const videoCandidates = new Map()
    for (const image of images) {
      const candidates = videos.filter(
        (video) => normalizedName(video.name) === normalizedName(image.name)
      )
      if (candidates.length === 0) {
        deleteItems.push({ ...image, reason: '未匹配同层视频' })
        continue
      }
      if (candidates.length > 1) {
        deleteItems.push({ ...image, reason: '图片匹配多个视频，按规则不保留' })
        conflicts.push({
          type: 'image-multi-video',
          image: image.relativePath,
          videos: candidates.map((v) => v.relativePath)
        })
        continue
      }
      const video = candidates[0]
      if (!videoCandidates.has(video.relativePath)) videoCandidates.set(video.relativePath, [])
      videoCandidates.get(video.relativePath).push(image)
    }

    for (const video of videos) {
      const matched = videoCandidates.get(video.relativePath) ?? []
      if (matched.length === 0) {
        keep.push(video)
        continue
      }
      if (matched.length === 1) {
        keep.push(video)
        keep.push({
          ...matched[0],
          posterFor: video.relativePath,
          finalName: posterFinalName(video.relativePath)
        })
        continue
      }
      // 一视频多图：-poster 优先 → 完全同名次之 → 待人工手选
      const posterPick =
        matched.find((image) => hasPosterSuffix(image.name)) ??
        matched.find((image) => stemOf(image.name) === stemOf(video.name))
      keep.push(video)
      if (posterPick) {
        keep.push({
          ...posterPick,
          posterFor: video.relativePath,
          finalName: posterFinalName(video.relativePath)
        })
        for (const image of matched) {
          if (image !== posterPick)
            deleteItems.push({ ...image, reason: '未被选为 poster 的候选图' })
        }
      } else {
        conflicts.push({
          type: 'video-multi-image',
          video: video.relativePath,
          images: matched.map((i) => i.relativePath)
        })
        pendingPick.push({
          video: video.relativePath,
          candidates: matched.map((i) => i.relativePath)
        })
      }
    }
  }

  const { risk, deleteBytes } = assessRisk(deleteItems, videoCount)

  const plan = {
    root,
    keep,
    deleteItems,
    pendingPick,
    moves: predictMoves(keep, skippedHidden),
    conflicts,
    skippedHidden,
    deleteBytes,
    risk,
    summary: {
      videos: videoCount,
      images: imageCount,
      otherFiles: otherCount,
      keep: keep.length,
      permanentDelete: deleteItems.length,
      pendingPick: pendingPick.length,
      hiddenSkipped: skippedHidden.length,
      conflicts: conflicts.length
    }
  }
  // 各消费方（clean/poster/merge/nfo/dedupe/health）只读计划，可安全共享同一对象
  if (planCache.size >= PLAN_CACHE_MAX) planCache.clear()
  planCache.set(root, { fingerprint, plan })
  return plan
}
