import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  discardStagedFile,
  pathExists,
  recoverStagedOutputs,
  sha256File,
  writeAtomicTextFile
} from '../../core/fs-ops.mjs'
import {
  COMIC_STATE_NAME,
  LEGACY_COMIC_COVER_NAME,
  comicCoverName,
  compareComicNames,
  diffComicChapters,
  isComicCoverName,
  isComicFailedDirName,
  isComicImage,
  sortComicChapters
} from '../../../shared/comic-rules.mjs'

/**
 * 漫画工作区扫描：
 * - 工作区一级子文件夹 = 一部漫画（文件夹名即漫画名）；
 * - 漫画目录的子文件夹 = 章节（数字感知自然排序）；
 * - 漫画目录下的扁平图片 = 归入 relDir 为 '' 的「正篇」虚拟章节（排最前）；
 * - 读取 .comic-merge.json 清单得到已合并状态，并 diff 出可增量更新的新章节。
 * 隐藏项（. 开头）整体跳过；清单/封面隐藏文件不参与章节统计。
 */

const SCAN_LANES = 4
export const COMIC_STATE_PENDING_NAME = '.comic-merge.pending.json'

const isHiddenName = (name) => name.startsWith('.')

/**
 * 递归收集目录内图片（相对漫画目录的正斜杠路径，自然排序；隐藏项跳过）。
 * 不再提供会影响章节差异判断的不完整 light 扫描：嵌套目录也是有效章节页，
 * 因此每次扫描都递归收集图片，避免把已有章节误判为“新章节”后重复追加。
 */
const throwIfAborted = (signal) => {
  if (signal?.aborted) throw new Error('扫描已取消')
}

async function collectImages(comicDir, relDir, comicName, { signal } = {}) {
  const out = []
  const walk = async (current) => {
    throwIfAborted(signal)
    const entries = await readdir(join(comicDir, current), { withFileTypes: true })
    for (const entry of entries) {
      throwIfAborted(signal)
      if (isHiddenName(entry.name) || entry.isSymbolicLink()) continue
      const rel = current ? `${current}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(rel)
      else if (
        entry.isFile() &&
        isComicImage(entry.name) &&
        !isComicCoverName(entry.name, comicName)
      )
        out.push(rel)
    }
  }
  await walk(relDir)
  return out.sort(compareComicNames)
}

const snapshotEntry = async (comicDir, relPath) => {
  const info = await stat(join(comicDir, relPath))
  return { relPath, size: info.size, mtimeMs: info.mtimeMs }
}

/**
 * 为已完整扫描的漫画创建轻量一致性快照。执行前只需 stat 已知目录和图片，
 * 无需再次 readdir 整棵目录树；任何新增/删除页都会改变其所在目录的 mtime。
 */
async function createComicSnapshot(comicDir, chapters) {
  const directoryPaths = new Set([''])
  const imagePaths = []
  for (const chapter of chapters) {
    if (chapter.relDir) {
      const segments = chapter.relDir.split('/')
      for (let index = 1; index <= segments.length; index += 1) {
        directoryPaths.add(segments.slice(0, index).join('/'))
      }
    }
    for (const image of chapter.images) {
      imagePaths.push(image)
      const segments = image.split('/')
      for (let index = 1; index < segments.length; index += 1) {
        directoryPaths.add(segments.slice(0, index).join('/'))
      }
    }
  }
  return {
    directories: await Promise.all(
      [...directoryPaths].map(async (relPath) => {
        const info = await stat(join(comicDir, relPath))
        return { relPath, mtimeMs: info.mtimeMs }
      })
    ),
    images: await Promise.all(imagePaths.map((relPath) => snapshotEntry(comicDir, relPath)))
  }
}

/** 执行前轻量校验扫描快照；不可信或过期时调用方必须重新完整扫描。 */
export async function isComicSnapshotCurrent(root, relDir, snapshot, { signal } = {}) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.directories) ||
    !Array.isArray(snapshot.images) ||
    snapshot.directories.length === 0
  ) {
    return false
  }
  const comicDir = join(root, relDir)
  try {
    for (const entry of snapshot.directories) {
      throwIfAborted(signal)
      if (typeof entry?.relPath !== 'string' || !Number.isFinite(entry.mtimeMs)) return false
      const info = await stat(join(comicDir, entry.relPath))
      if (!info.isDirectory() || info.mtimeMs !== entry.mtimeMs) return false
    }
    for (const entry of snapshot.images) {
      throwIfAborted(signal)
      if (
        typeof entry?.relPath !== 'string' ||
        !Number.isFinite(entry.size) ||
        !Number.isFinite(entry.mtimeMs)
      ) {
        return false
      }
      const info = await stat(join(comicDir, entry.relPath))
      if (!info.isFile() || info.size !== entry.size || info.mtimeMs !== entry.mtimeMs) return false
    }
    return true
  } catch {
    return false
  }
}

/** 读取合并清单（不存在/损坏/产物被删时返回 null） */
export async function readComicState(comicDir) {
  try {
    const state = JSON.parse(await readFile(join(comicDir, COMIC_STATE_NAME), 'utf8'))
    if (state?.version !== 1 || !Array.isArray(state.chapters) || !state.outputName) return null
    // 产物文件被外部删除时视为未合并
    if (!(await pathExists(join(comicDir, state.outputName)))) return null
    return state
  } catch {
    return null
  }
}

/**
 * 产物安全替换后、清单落盘前若进程退出，pending marker 带有产物摘要与完整新清单。
 * 只有目标产物确实匹配已校验暂存产物时才提交清单，杜绝旧产物被误标为已追加。
 */
export async function recoverComicStateTransaction(comicDir) {
  const markerPath = join(comicDir, COMIC_STATE_PENDING_NAME)
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    if (
      marker?.version !== 1 ||
      typeof marker.outputHash !== 'string' ||
      typeof marker.outputName !== 'string' ||
      !marker.state ||
      marker.state.outputName !== marker.outputName
    ) {
      return false
    }
    const outputPath = join(comicDir, marker.outputName)
    if (!(await pathExists(outputPath)) || (await sha256File(outputPath)) !== marker.outputHash) {
      await discardStagedFile(markerPath)
      return false
    }
    await writeAtomicTextFile(
      join(comicDir, COMIC_STATE_NAME),
      JSON.stringify(marker.state, null, 2)
    )
    await discardStagedFile(markerPath)
    return true
  } catch {
    return false
  }
}

/** 扫描单部漫画（始终递归章节目录，确保与合并判断使用同一完整快照） */
export async function scanComic(root, relDir, { signal } = {}) {
  throwIfAborted(signal)
  const comicDir = join(root, relDir)
  // 扫描前恢复上次断电/进程被终止时遗留的安全替换备份。
  await recoverStagedOutputs(comicDir)
  await recoverComicStateTransaction(comicDir)
  const entries = await readdir(comicDir, { withFileTypes: true })

  const chapterDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !isHiddenName(entry.name))
    .map((entry) => entry.name)
  const flatImages = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !isHiddenName(entry.name) &&
        isComicImage(entry.name) &&
        !isComicCoverName(entry.name, relDir)
    )
    .map((entry) => entry.name)
    .sort(compareComicNames)

  const chapters = []
  if (flatImages.length > 0) chapters.push({ name: '', relDir: '', images: flatImages })
  for (const dir of chapterDirs) {
    const images = await collectImages(comicDir, dir, relDir, { signal })
    if (images.length > 0) chapters.push({ name: dir, relDir: dir, images })
  }
  const sorted = sortComicChapters(chapters)

  const merged = await readComicState(comicDir)
  const { newChapters, changedChapters } = diffComicChapters(sorted, merged)

  let coverRel = sorted[0]?.images[0] ?? null
  const coverName = comicCoverName(relDir)
  if (merged?.coverName && (await pathExists(join(comicDir, merged.coverName)))) {
    coverRel = merged.coverName
  } else if (merged && (await pathExists(join(comicDir, coverName)))) {
    // 兼容首个可见封面版本的清单（尚未登记 coverName）。
    coverRel = coverName
  } else if (merged && (await pathExists(join(comicDir, LEGACY_COMIC_COVER_NAME)))) {
    // 兼容既有工作区的隐藏封面。
    coverRel = LEGACY_COMIC_COVER_NAME
  }

  return {
    name: relDir,
    relDir,
    chapters: sorted,
    imageCount: sorted.reduce((sum, chapter) => sum + chapter.images.length, 0),
    coverRel,
    merged,
    newChapters,
    changedChapters,
    snapshot: await createComicSnapshot(comicDir, sorted)
  }
}

/** 扫描漫画工作区：一级子文件夹逐部解析（车道并发 4，目录读很轻快）。 */
export async function scanComicWorkspace(root, { signal } = {}) {
  throwIfAborted(signal)
  const entries = await readdir(root, { withFileTypes: true })
  const comicDirs = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !isHiddenName(entry.name) &&
        !isComicFailedDirName(entry.name)
    )
    .map((entry) => entry.name)
    .sort(compareComicNames)

  const comics = []
  let cursor = 0
  const worker = async () => {
    while (cursor < comicDirs.length) {
      throwIfAborted(signal)
      const relDir = comicDirs[cursor]
      cursor += 1
      try {
        comics.push(await scanComic(root, relDir, { signal }))
      } catch (error) {
        if (signal?.aborted) throw error
        // 单部漫画读取失败（权限/竞态删除）跳过，不阻断整体
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_LANES, comicDirs.length) }, worker))

  comics.sort((a, b) => compareComicNames(a.name, b.name))
  return {
    comics,
    totalImages: comics.reduce((sum, comic) => sum + comic.imageCount, 0)
  }
}
