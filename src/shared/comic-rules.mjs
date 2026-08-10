/**
 * 漫画模块纯规则库：不依赖 Node/Electron，main / renderer / node:test 三端共用。
 * 章节与图片的排序、更新检测全部集中在此，保证双端语义一致。
 */

/** 漫画图片扩展名（覆盖常见下载格式；webp 会在合并时统一转码） */
export const COMIC_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.avif'
])

/** 合并清单文件名（隐藏文件，扫描整体跳过） */
export const COMIC_STATE_NAME = '.comic-merge.json'

/** 删源后留存的封面缩略图（隐藏文件） */
export const COMIC_COVER_NAME = '.comic-cover.jpg'

const extLower = (name) => {
  const index = String(name).lastIndexOf('.')
  return index < 0 ? '' : String(name).slice(index).toLowerCase()
}

export const isComicImage = (name) => COMIC_IMAGE_EXTENSIONS.has(extLower(name))

/** 漫画输出文件名：<漫画名>.<epub|pdf> */
export const comicOutputName = (comicName, format) => `${comicName}.${format}`

/** 数字感知自然排序：「第2话」<「第10话」，中文按拼音 */
export const compareComicNames = (a, b) =>
  String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true })

/**
 * 章节排序：扁平图片虚拟章节（relDir ''）排最前，其余按名称自然排序。
 * @param {Array<{name: string, relDir: string}>} chapters
 */
export function sortComicChapters(chapters) {
  return [...chapters].sort((a, b) => {
    if (a.relDir === '' && b.relDir !== '') return -1
    if (a.relDir !== '' && b.relDir === '') return 1
    return compareComicNames(a.name, b.name)
  })
}

/** 章节展示名：扁平虚拟章节显示为「正篇」 */
export const chapterDisplayName = (chapter) => (chapter.relDir === '' ? '正篇' : chapter.name)

/**
 * 更新检测：对比当前章节与已合并清单。
 * @param {Array<{name: string, relDir: string, images: string[]}>} chapters 当前扫描结果（已排序）
 * @param {{chapters: Array<{relDir: string, images: string[]}>} | null} merged 已合并清单
 * @returns {{newChapters: Array, changedChapters: string[]}}
 *   newChapters：清单中不存在的章节（可增量追加）；
 *   changedChapters：清单中存在但图片列表已变的章节名（需全量重建，不支持就地修改）。
 */
export function diffComicChapters(chapters, merged) {
  if (!merged || !Array.isArray(merged.chapters)) {
    return { newChapters: [...chapters], changedChapters: [] }
  }
  const mergedByDir = new Map(merged.chapters.map((chapter) => [chapter.relDir, chapter]))
  const newChapters = []
  const changedChapters = []
  for (const chapter of chapters) {
    const old = mergedByDir.get(chapter.relDir)
    if (!old) {
      newChapters.push(chapter)
      continue
    }
    const oldImages = Array.isArray(old.images) ? old.images : []
    const changed =
      oldImages.length !== chapter.images.length ||
      chapter.images.some((image, index) => oldImages[index] !== image)
    if (changed) changedChapters.push(chapterDisplayName(chapter))
  }
  return { newChapters, changedChapters }
}
