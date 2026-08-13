import { join } from 'node:path'
import sharp from 'sharp'
import { scanComic } from './scan.mjs'
import { appendEpubFile, createEpubFile, verifyEpubFile } from './epub.mjs'
import { appendPdf, createPdf, verifyPdfFile } from './pdf.mjs'
import {
  commitStagedFile,
  createStagingPath,
  discardStagedFile,
  fileSize,
  pathExists,
  readBinaryFile,
  removeEmptyDirs,
  writeAtomicTextFile,
  writeBinaryFile
} from '../../core/fs-ops.mjs'
import {
  COMIC_STATE_NAME,
  LEGACY_COMIC_COVER_NAME,
  chapterDisplayName,
  comicCoverName,
  comicOutputName
} from '../../../shared/comic-rules.mjs'

/**
 * 漫画合并执行：
 * - 全量合并：全部章节按自然顺序打包为单个 EPUB/PDF；
 * - 增量更新：清单存在且仅新增章节时，新章节按顺序追加到既有产物末尾（原页面不重编码）；
 * - 图片优化（默认）：宽度 >1600 缩至 1600，统一转 mozjpeg q85（质量/体积平衡）；
 *   原样模式：不重编码不改尺寸（PDF 仅支持 jpg/png 直嵌，其他格式转码 jpg q92）；
 * - 产物写在漫画目录内（<漫画名>.<格式>），清单 .comic-merge.json 记录章节快照供下次更新检测；
 * - 删源（deleteComicSources）：删除已合并图片并清理空章节目录，保留产物/清单/隐藏封面。
 */

/** 优化模式图片最大宽度（条漫常见 800–1280，1600 覆盖高清来源） */
const OPT_MAX_WIDTH = 1600
const OPT_JPEG_QUALITY = 85
const RAW_JPEG_QUALITY = 92
const COVER_WIDTH = 400

const PDF_DIRECT_EXTS = new Set(['jpg', 'jpeg', 'png'])
const throwIfAborted = (signal) => {
  if (signal?.aborted) throw new Error('已取消')
}

const extOf = (name) => {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index + 1).toLowerCase()
}

/**
 * 图片预处理：读入 → （可选）缩放/转码 → { data, width, height, ext }。
 * @param {string} absPath
 * @param {{format: 'epub'|'pdf', raw: boolean}} options
 */
async function preparePage(absPath, { format, raw }) {
  const buffer = await readBinaryFile(absPath)
  const sourceExt = extOf(absPath)
  // sharp 默认像素上限约 2.68 亿，条漫长图可能超限，关闭限制（本地可信文件）。
  // 此函数只在当前页生命周期内保留 Buffer，绝不累积整章/整书图片。
  const image = sharp(buffer, { limitInputPixels: false })

  if (raw && (format === 'epub' || PDF_DIRECT_EXTS.has(sourceExt))) {
    const metadata = await image.metadata()
    return {
      data: buffer,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      ext: sourceExt === 'jpeg' ? 'jpg' : sourceExt,
      sourceBytes: buffer.length
    }
  }

  const quality = raw ? RAW_JPEG_QUALITY : OPT_JPEG_QUALITY
  let pipeline = sharp(buffer, { limitInputPixels: false })
  const metadata = await pipeline.metadata()
  if (!raw && (metadata.width ?? 0) > OPT_MAX_WIDTH) {
    pipeline = pipeline.resize({ width: OPT_MAX_WIDTH, withoutEnlargement: true })
  }
  if (metadata.hasAlpha) pipeline = pipeline.flatten({ background: '#ffffff' })
  const { data, info } = await pipeline
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, ext: 'jpg', sourceBytes: buffer.length }
}

/**
 * 合并单部漫画。
 * @param {string} root 工作区
 * @param {string} relDir 漫画相对目录
 * @param {{format: 'epub'|'pdf', raw?: boolean, rebuild?: boolean, signal?: AbortSignal, onProgress?: (progress: {completedPages: number, totalPages: number, current?: string}) => void}} options
 * @returns {Promise<import('../../../shared/types').ComicMergeItem>}
 */
export async function mergeOneComic(
  root,
  relDir,
  { format, raw = false, rebuild = false, signal, onProgress }
) {
  const comic = await scanComic(root, relDir)
  const comicDir = join(root, relDir)
  const state = rebuild ? null : comic.merged

  if (comic.imageCount === 0 && !state) throw new Error('没有可合并的图片')
  if (state && state.format !== format) {
    // 换格式必须全量重建（EPUB/PDF 结构不同，无法互转追加）
  } else if (state) {
    if (comic.changedChapters.length > 0) {
      throw new Error(
        `章节「${comic.changedChapters[0]}」等内容已变化，请改用全量重建（勾选后重试）`
      )
    }
    if (comic.newChapters.length === 0) throw new Error('没有新章节可追加')
  }

  const sameFormat = state && state.format === format
  const mode = sameFormat ? 'update' : 'full'
  const chaptersToProcess = mode === 'full' ? comic.chapters : comic.newChapters
  const outputName = comicOutputName(comic.name, format)
  const outputPath = join(comicDir, outputName)
  const priorPageCount =
    mode === 'update' ? state.chapters.reduce((sum, chapter) => sum + chapter.images.length, 0) : 0
  const processedPageCount = chaptersToProcess.reduce(
    (sum, chapter) => sum + chapter.images.length,
    0
  )
  const emitPageProgress = (progress) =>
    onProgress?.({
      completedPages: Math.max(0, progress.completedPages - priorPageCount),
      totalPages: processedPageCount,
      current: comic.name,
      phase: format === 'epub' ? '正在写入 EPUB 页面' : '正在处理 PDF 页面'
    })

  // EPUB 采用流式 ZIP：逐页读取/转码/写入，数千页也不会累积整书 Buffer。
  // PDF 受 pdf-lib 限制仍需完整序列化，故仅在 PDF 分支保留逐页预处理数组。
  let sourceBytes = 0
  let outputBytes = 0
  if (format === 'epub') {
    const stagingPath = createStagingPath(outputPath)
    const streamChapters = chaptersToProcess.map((chapter) => ({
      name: chapterDisplayName(chapter),
      pages: chapter.images.map((image) => ({ path: join(comicDir, image) }))
    }))
    const expectedPages =
      (mode === 'update'
        ? state.chapters.reduce((sum, chapter) => sum + chapter.images.length, 0)
        : 0) + streamChapters.reduce((sum, chapter) => sum + chapter.pages.length, 0)
    const prepareStreamPage = async ({ path }) => {
      // 原样 EPUB 无须读入图片；sharp 仅读取元数据，yazl 在写入时按需流式读取源文件。
      if (raw) {
        const metadata = await sharp(path, { limitInputPixels: false }).metadata()
        const source = await fileSize(path)
        sourceBytes += source
        return {
          sourcePath: path,
          width: metadata.width ?? 0,
          height: metadata.height ?? 0,
          ext: extOf(path),
          sourceBytes: source
        }
      }
      const page = await preparePage(path, { format, raw })
      sourceBytes += page.sourceBytes ?? page.data.length
      return page
    }
    try {
      if (mode === 'update') {
        await appendEpubFile({
          sourcePath: outputPath,
          outputPath: stagingPath,
          title: comic.name,
          existingChapters: state.chapters.map((chapter) => ({
            name: chapterDisplayName(chapter),
            pageCount: chapter.images.length
          })),
          newChapters: streamChapters,
          preparePage: prepareStreamPage,
          signal,
          onProgress: emitPageProgress
        })
      } else {
        await createEpubFile({
          outputPath: stagingPath,
          title: comic.name,
          chapters: streamChapters,
          preparePage: prepareStreamPage,
          signal,
          onProgress: emitPageProgress
        })
      }
      if (signal?.aborted) throw new Error('已取消')
      onProgress?.({
        completedPages: processedPageCount,
        totalPages: processedPageCount,
        current: comic.name,
        phase: '正在校验 EPUB 结构并安全替换产物'
      })
      await verifyEpubFile(stagingPath, expectedPages)
      await commitStagedFile(stagingPath, outputPath)
      outputBytes = await fileSize(outputPath)
    } catch (error) {
      await discardStagedFile(stagingPath)
      throw error
    }
  } else {
    // pdf-lib 仍需完整序列化，但避免额外保留章节嵌套数组；超大书建议使用 EPUB。
    const pages = []
    for (const chapter of chaptersToProcess) {
      for (const image of chapter.images) {
        if (signal?.aborted) throw new Error('已取消')
        const page = await preparePage(join(comicDir, image), { format, raw })
        pages.push(page)
        sourceBytes += page.sourceBytes ?? page.data.length
        onProgress?.({
          completedPages: pages.length,
          totalPages: processedPageCount,
          current: comic.name,
          phase: '正在处理 PDF 页面'
        })
      }
    }
    const expectedPages =
      (mode === 'update'
        ? state.chapters.reduce((sum, chapter) => sum + chapter.images.length, 0)
        : 0) + pages.length
    const stagingPath = createStagingPath(outputPath)
    try {
      const bytes =
        mode === 'update'
          ? await appendPdf(await readBinaryFile(outputPath), { pages })
          : await createPdf({ title: comic.name, pages })
      if (signal?.aborted) throw new Error('已取消')
      onProgress?.({
        completedPages: processedPageCount,
        totalPages: processedPageCount,
        current: comic.name,
        phase: '正在生成并校验 PDF 文档'
      })
      await writeBinaryFile(stagingPath, bytes)
      await verifyPdfFile(stagingPath, expectedPages)
      await commitStagedFile(stagingPath, outputPath)
      outputBytes = await fileSize(outputPath)
    } catch (error) {
      await discardStagedFile(stagingPath)
      throw error
    }
  }

  // 封面缩略图使用可见的「漫画名-cover.jpg」；扫描规则会忽略它，绝不视为新内容。
  // 若同名文件不是本应用在清单中登记的封面，绝不覆盖用户原图。
  const coverName = comicCoverName(comic.name)
  const coverPath = join(comicDir, coverName)
  const mayWriteCover = !(await pathExists(coverPath)) || comic.merged?.coverName === coverName
  let managedCoverName = comic.merged?.coverName
  if (mode === 'full' && comic.chapters[0]?.images[0] && mayWriteCover) {
    const cover = await sharp(join(comicDir, comic.chapters[0].images[0]), {
      limitInputPixels: false
    })
      .resize({ width: COVER_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer()
    await writeBinaryFile(coverPath, cover)
    managedCoverName = coverName
    // 旧版隐藏封面不再使用，成功写入可见封面后删除，避免目录中保留两份。
    await discardStagedFile(join(comicDir, LEGACY_COMIC_COVER_NAME))
  }

  const mergedChapters =
    mode === 'update' ? [...state.chapters, ...comic.newChapters] : comic.chapters
  const newState = {
    version: 1,
    format,
    outputName,
    outputBytes,
    coverName: managedCoverName,
    chapters: mergedChapters.map((chapter) => ({
      name: chapter.name,
      relDir: chapter.relDir,
      images: chapter.images
    })),
    updatedAt: new Date().toISOString()
  }
  // 清单在产物校验、事务提交都成功后才更新，避免清单指向半成品。
  await writeAtomicTextFile(join(comicDir, COMIC_STATE_NAME), JSON.stringify(newState, null, 2))

  return {
    relDir,
    name: comic.name,
    mode,
    outputName,
    chapters: chaptersToProcess.length,
    images: chaptersToProcess.reduce((sum, chapter) => sum + chapter.images.length, 0),
    bytes: outputBytes,
    sourceBytes
  }
}

/**
 * 批量合并（TaskCenter 并发，一项一部漫画）。
 * @param {string} root
 * @param {{relDirs: string[], format: 'epub'|'pdf', raw?: boolean, rebuild?: boolean, taskCenter: object, taskId: string, concurrency?: number, signal?: AbortSignal, onProgress?: (progress: {completed: number, total: number, current: string, done?: boolean, cancelled?: boolean}) => void}} options
 * @returns {Promise<import('../../../shared/types').ComicMergeReport>}
 */
export async function mergeComics(
  root,
  {
    relDirs,
    format,
    raw = false,
    rebuild = false,
    taskCenter,
    taskId,
    concurrency = 5,
    signal,
    onProgress
  }
) {
  const startedAt = Date.now()
  const report = { taskId, cancelled: false, format, merged: [], failed: [], durationMs: 0 }

  if (relDirs.length === 0) {
    report.durationMs = Date.now() - startedAt
    return report
  }

  // 预先扫描一次以获得稳定的页数总量；这让数千页长漫画能显示实际页进度，而非只显示“第几本”。
  const plans = []
  // 扫描本身也是大量目录 I/O；顺序预扫描既避免抢占资源管理器，又使取消从任务创建前就生效。
  for (const relDir of relDirs) {
    throwIfAborted(signal)
    const comic = await scanComic(root, relDir)
    const update = !rebuild && comic.merged?.format === format
    const chapters = update ? comic.newChapters : comic.chapters
    plans.push({ relDir, total: chapters.reduce((sum, chapter) => sum + chapter.images.length, 0) })
  }
  const totalPages = plans.reduce((sum, plan) => sum + plan.total, 0)
  const completedByComic = new Map()
  const reportProgress = (relDir, progress) => {
    completedByComic.set(relDir, progress.completedPages)
    const completed = [...completedByComic.values()].reduce((sum, value) => sum + value, 0)
    onProgress?.({
      completed,
      total: totalPages,
      current: `${progress.phase ?? '处理页面'} · ${progress.current ?? relDir} · ${progress.completedPages}/${progress.totalPages} 页`
    })
  }
  onProgress?.({ completed: 0, total: totalPages, current: '准备合并漫画：统计章节与页数' })

  const result = await taskCenter.run({
    taskId,
    label: format === 'epub' ? '合并漫画（EPUB）' : '合并漫画（PDF）',
    items: relDirs,
    // 单部漫画内部已经顺序处理图片；同时处理多部超大漫画会争抢磁盘与内存。
    // EPUB 至多 2 本并行，PDF 强制单本，优先保证 Windows 的稳定性。
    concurrency: format === 'pdf' ? 1 : Math.min(2, concurrency),
    signal,
    worker: async (relDir, signal) => {
      if (signal?.aborted) throw new Error('已取消')
      const item = await mergeOneComic(root, relDir, {
        format,
        raw,
        rebuild,
        signal,
        onProgress: (progress) => reportProgress(relDir, progress)
      })
      completedByComic.set(
        relDir,
        plans.find((plan) => plan.relDir === relDir)?.total ?? item.images
      )
      report.merged.push(item)
    }
  })
  report.cancelled = result.cancelled
  onProgress?.({
    completed: [...completedByComic.values()].reduce((sum, value) => sum + value, 0),
    total: totalPages,
    current: result.cancelled ? '漫画合并已取消' : '漫画合并完成',
    done: !result.cancelled,
    cancelled: result.cancelled
  })
  result.results.forEach((entry, index) => {
    if (!entry.ok && !entry.cancelled) {
      report.failed.push({ target: relDirs[index], error: entry.error ?? '未知错误' })
    }
  })
  report.durationMs = Date.now() - startedAt
  return report
}

/**
 * 删除已合并漫画的源图片（经注入的 deleteFn，默认回收站），并清理空章节目录。
 * @param {string} root
 * @param {{relDirs: string[], taskCenter: object, taskId: string, concurrency?: number, deleteFn: (target: string) => Promise<void>}} options
 */
export async function deleteComicSources(
  root,
  { relDirs, taskCenter, taskId, concurrency = 5, deleteFn }
) {
  // 只依据成功提交的清单构建删除快照，绝不能把删除期间扫描到的残留页/新下载页混入。
  const targets = []
  for (const relDir of relDirs) {
    const comic = await scanComic(root, relDir)
    for (const chapter of comic.merged?.chapters ?? []) {
      for (const image of chapter.images) {
        const target = join(root, relDir, image)
        if (await pathExists(target)) targets.push(target)
      }
    }
  }

  const result = await taskCenter.run({
    taskId,
    label: '删除漫画源图片',
    items: targets,
    concurrency,
    worker: async (target, signal) => {
      if (signal?.aborted) throw new Error('已取消')
      await deleteFn(target)
      // shell.trashItem 在 Windows 上可能“已移动后仍报锁错误”；删除成功的唯一标准是源路径消失。
      if (await pathExists(target)) throw new Error('删除后文件仍存在，可能被其他程序占用')
    }
  })

  // 清理空章节目录（隐藏清单/封面所在目录不为空，自然保留）
  for (const relDir of relDirs) {
    await removeEmptyDirs(join(root, relDir)).catch(() => [])
  }

  return {
    cancelled: result.cancelled,
    deletedCount: result.completed,
    failed: result.results
      .map((entry, index) => ({ entry, target: targets[index] }))
      .filter(({ entry }) => !entry.ok && !entry.cancelled)
      .map(({ entry, target }) => ({ target, error: entry.error ?? '未知错误' }))
  }
}
