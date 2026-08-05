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

async function walk(root, current, records, skipped) {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(current, entry.name)
    if (isHiddenName(entry.name)) {
      skipped.push(relative(root, fullPath))
      continue
    }
    if (entry.isDirectory()) {
      await walk(root, fullPath, records, skipped)
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(fullPath)
    const relativePath = relative(root, fullPath)
    records.push({
      path: fullPath,
      relativePath,
      dir: dirname(relativePath),
      name: entry.name,
      kind: classifyPath(fullPath),
      size: info.size
    })
  }
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
export async function createScanPlan(root) {
  const records = []
  const skippedHidden = []
  await walk(root, root, records, skippedHidden)

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
        keep.push({ ...matched[0], posterFor: video.relativePath })
        continue
      }
      // 一视频多图：-poster 优先 → 完全同名次之 → 待人工手选
      const posterPick =
        matched.find((image) => hasPosterSuffix(image.name)) ??
        matched.find((image) => stemOf(image.name) === stemOf(video.name))
      keep.push(video)
      if (posterPick) {
        keep.push({ ...posterPick, posterFor: video.relativePath })
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

  return {
    root,
    keep,
    deleteItems,
    pendingPick,
    moves: keep
      .filter((item) => item.dir !== '.')
      .map((item) => ({ from: item.relativePath, to: item.name })),
    conflicts,
    skippedHidden,
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
}
