import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { recoverStagedOutputs } from '../../core/fs-ops.mjs'
import {
  COMIC_COVER_NAME,
  COMIC_STATE_NAME,
  compareComicNames,
  diffComicChapters,
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

const isHiddenName = (name) => name.startsWith('.')

const pathExists = async (target) => {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** 递归收集目录内图片（相对漫画目录的正斜杠路径，自然排序；隐藏项跳过） */
async function collectImages(comicDir, relDir) {
  const out = []
  const walk = async (current) => {
    const entries = await readdir(join(comicDir, current), { withFileTypes: true })
    for (const entry of entries) {
      if (isHiddenName(entry.name) || entry.isSymbolicLink()) continue
      const rel = current ? `${current}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(rel)
      else if (entry.isFile() && isComicImage(entry.name)) out.push(rel)
    }
  }
  await walk(relDir)
  return out.sort(compareComicNames)
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

/** 扫描单部漫画 */
export async function scanComic(root, relDir) {
  const comicDir = join(root, relDir)
  // 扫描前恢复上次断电/进程被终止时遗留的安全替换备份。
  await recoverStagedOutputs(comicDir)
  const entries = await readdir(comicDir, { withFileTypes: true })

  const chapterDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !isHiddenName(entry.name))
    .map((entry) => entry.name)
  const flatImages = entries
    .filter((entry) => entry.isFile() && !isHiddenName(entry.name) && isComicImage(entry.name))
    .map((entry) => entry.name)
    .sort(compareComicNames)

  const chapters = []
  if (flatImages.length > 0) chapters.push({ name: '', relDir: '', images: flatImages })
  for (const dir of chapterDirs) {
    const images = await collectImages(comicDir, dir)
    if (images.length > 0) chapters.push({ name: dir, relDir: dir, images })
  }
  const sorted = sortComicChapters(chapters)

  const merged = await readComicState(comicDir)
  const { newChapters, changedChapters } = diffComicChapters(sorted, merged)

  let coverRel = sorted[0]?.images[0] ?? null
  if (merged && (await pathExists(join(comicDir, COMIC_COVER_NAME)))) coverRel = COMIC_COVER_NAME

  return {
    name: relDir,
    relDir,
    chapters: sorted,
    imageCount: sorted.reduce((sum, chapter) => sum + chapter.images.length, 0),
    coverRel,
    merged,
    newChapters,
    changedChapters
  }
}

/** 扫描漫画工作区：一级子文件夹逐部解析（车道并发 4，目录读很轻快）。 */
export async function scanComicWorkspace(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const comicDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !isHiddenName(entry.name))
    .map((entry) => entry.name)
    .sort(compareComicNames)

  const comics = []
  let cursor = 0
  const worker = async () => {
    while (cursor < comicDirs.length) {
      const relDir = comicDirs[cursor]
      cursor += 1
      try {
        comics.push(await scanComic(root, relDir))
      } catch {
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
