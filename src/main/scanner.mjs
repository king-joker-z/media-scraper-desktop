/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'

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
export const normalizedName = (path) =>
  basename(path, extname(path))
    .toLowerCase()
    .replace(/-poster$/i, '')
    .replace(/[\s._-]+/g, '')

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
    records.push({
      path: fullPath,
      relativePath: relative(root, fullPath),
      name: entry.name,
      kind: classifyPath(fullPath),
      size: info.size
    })
  }
}

export async function createScanPlan(root) {
  const records = []
  const skippedHidden = []
  await walk(root, root, records, skippedHidden)
  const videos = records.filter((item) => item.kind === 'video')
  const images = records.filter((item) => item.kind === 'image')
  const others = records.filter((item) => item.kind === 'other')
  const videoKeys = new Map()
  for (const video of videos) {
    const key = normalizedName(video.name)
    videoKeys.set(key, [...(videoKeys.get(key) ?? []), video])
  }
  const keep = [...videos]
  const deleteItems = [...others]
  const conflicts = []
  for (const image of images) {
    const candidates = videoKeys.get(normalizedName(image.name)) ?? []
    if (candidates.length === 1) keep.push({ ...image, posterFor: candidates[0].relativePath })
    else {
      deleteItems.push({
        ...image,
        reason: candidates.length > 1 ? '图片匹配多个视频，按规则不保留' : '未匹配同层视频'
      })
      if (candidates.length > 1)
        conflicts.push({ image: image.relativePath, videos: candidates.map((v) => v.relativePath) })
    }
  }
  return {
    root,
    keep,
    deleteItems,
    conflicts,
    skippedHidden,
    moves: keep
      .filter((item) => item.relativePath.includes('/'))
      .map((item) => ({ from: item.relativePath, to: item.name })),
    summary: {
      videos: videos.length,
      images: images.length,
      otherFiles: others.length,
      keep: keep.length,
      permanentDelete: deleteItems.length,
      hiddenSkipped: skippedHidden.length,
      conflicts: conflicts.length
    }
  }
}
