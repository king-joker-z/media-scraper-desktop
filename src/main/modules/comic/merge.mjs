import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { COMIC_STATE_PENDING_NAME, scanComic } from './scan.mjs'
import { appendEpubFile, createEpubFile, verifyEpubFile } from './epub.mjs'
import { appendPdf, createPdf, verifyPdfFile } from './pdf.mjs'
import {
  commitStagedFile,
  createStagingPath,
  discardStagedFile,
  fileSize,
  moveWithCollision,
  pathExists,
  readBinaryFile,
  removeEmptyDirs,
  writeAtomicTextFile,
  writeBinaryFile
} from '../../core/fs-ops.mjs'
import {
  COMIC_FAILED_DIR_NAME,
  COMIC_STATE_NAME,
  LEGACY_COMIC_COVER_NAME,
  chapterDisplayName,
  comicCoverName,
  comicOutputName
} from '../../../shared/comic-rules.mjs'
import { needsJpegRepair } from '../../../shared/jpeg-guard.mjs'

/**
 * 漫画合并执行：
 * - 全量合并：全部章节按自然顺序打包为单个 EPUB/PDF；
 * - 增量更新：清单存在且仅新增章节时，新章节按顺序追加到既有产物末尾（原页面不重编码）；
 * - 图片优化（默认）：宽度 >1600 缩至 1600，统一转 mozjpeg q85（质量/体积平衡）；
 *   原样模式：不重编码不改尺寸（PDF 仅支持 jpg/png 直嵌，其他格式转码 jpg q92）；
 * - 坏 JPEG 自动修复：结构异常（libjpeg「extraneous bytes before marker」等，sharp 默认
 *   failOn='warning' 会直接抛错）或内容非 JPEG 的 .jpg 页，自动宽容解码转码为干净 JPEG，
 *   避免整本合并失败或坏图原样进入 EPUB/PDF；修复页数计入合并结果 repairedPages；
 * - 产物写在漫画目录内（<漫画名>.<格式>），清单 .comic-merge.json 记录章节快照供下次更新检测；
 * - 删源（deleteComicSources）：删除已合并图片并清理空章节目录，保留产物/清单/隐藏封面。
 */

/** 优化模式图片最大宽度（条漫常见 800–1280，1600 覆盖高清来源） */
const OPT_MAX_WIDTH = 1600
const OPT_JPEG_QUALITY = 85
const RAW_JPEG_QUALITY = 92
const COVER_WIDTH = 400

const PDF_DIRECT_EXTS = new Set(['jpg', 'jpeg', 'png'])
/** PDF 单本内页级转码并发：pdf-lib 仍需整本驻留，故不并行多本；页级并行只多占用在途页 Buffer */
const PDF_PAGE_CONCURRENCY = 4
const throwIfAborted = (signal) => {
  if (signal?.aborted) throw new Error('已取消')
}

const extOf = (name) => {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index + 1).toLowerCase()
}

const isJpegExt = (ext) => ext === 'jpg' || ext === 'jpeg'

// sharp 0.35 默认 failOn='warning'：libjpeg 对「标记前有多余字节」等坏 JPEG 告警会直接抛错，
// 导致漫画合并整本失败。此正则识别这类可宽容解码修复的错误（严格解码失败时降级重试）。
const isRepairableJpegError = (error) =>
  /VipsJpeg|Corrupt JPEG data|extraneous bytes|Premature end of JPEG/i.test(
    String(error?.message ?? error)
  )

/**
 * 经 sharp 编码为 JPEG。宽容模式（failOn:'none'）让 libjpeg 跳过垃圾字节完成解码，
 * 相当于把结构异常的坏图修复为干净 JPEG（像素与严格解码一致，见 test/jpeg-guard.test.mjs）。
 * @param {Buffer} buffer
 * @param {{quality: number, maxWidth?: number, tolerant?: boolean}} options
 */
async function encodeToJpeg(buffer, { quality, maxWidth = 0, tolerant = false }) {
  const options = { limitInputPixels: false }
  if (tolerant) options.failOn = 'none'
  let pipeline = sharp(buffer, options)
  const metadata = await pipeline.metadata()
  if (maxWidth > 0 && (metadata.width ?? 0) > maxWidth) {
    pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true })
  }
  if (metadata.hasAlpha) pipeline = pipeline.flatten({ background: '#ffffff' })
  const { data, info } = await pipeline
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, ext: 'jpg' }
}

/**
 * 严格解码，命中坏 JPEG（libjpeg 告警级，sharp 默认 failOn='warning' 会抛错）时
 * 降级为宽容解码修复。
 * @returns {{data: Buffer, width: number, height: number, ext: string, repaired: boolean}}
 */
async function encodeWithRepair(buffer, { quality, maxWidth = 0 }) {
  try {
    return { ...(await encodeToJpeg(buffer, { quality, maxWidth })), repaired: false }
  } catch (error) {
    if (isRepairableJpegError(error)) {
      return {
        ...(await encodeToJpeg(buffer, { quality, maxWidth, tolerant: true })),
        repaired: true
      }
    }
    throw error
  }
}

/**
 * 图片预处理：读入 → （可选）缩放/转码 → { data, width, height, ext, repaired }。
 * - 优化模式（默认）：统一重编码，坏 JPEG 自动走宽容解码修复；
 * - 原样模式：jpg/png 尽量保留源字节；结构异常的 jpg/jpeg 转码修复，
 *   避免把 libjpeg 无法正常解码的坏图直接塞进 EPUB/PDF（阅读器渲染异常）。
 * 此函数只在当前页生命周期内保留 Buffer，绝不累积整章/整书图片。
 * @param {string} absPath
 * @param {{format: 'epub'|'pdf', raw: boolean}} options
 */
async function preparePage(absPath, { format, raw }) {
  const buffer = await readBinaryFile(absPath)
  const sourceExt = extOf(absPath)

  if (raw && (format === 'epub' || PDF_DIRECT_EXTS.has(sourceExt))) {
    if (isJpegExt(sourceExt) && needsJpegRepair(buffer)) {
      return {
        ...(await encodeToJpeg(buffer, { quality: RAW_JPEG_QUALITY, tolerant: true })),
        repaired: true,
        sourceBytes: buffer.length
      }
    }
    const metadata = await sharp(buffer, { limitInputPixels: false }).metadata()
    return {
      data: buffer,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      ext: sourceExt === 'jpeg' ? 'jpg' : sourceExt,
      sourceBytes: buffer.length,
      repaired: false
    }
  }

  const quality = raw ? RAW_JPEG_QUALITY : OPT_JPEG_QUALITY
  const page = await encodeWithRepair(buffer, {
    quality,
    maxWidth: raw ? 0 : OPT_MAX_WIDTH
  })
  return { ...page, sourceBytes: buffer.length }
}

/**
 * 合并单部漫画。
 * @param {string} root 工作区
 * @param {string} relDir 漫画相对目录
 * @param {{format: 'epub'|'pdf', raw?: boolean, rebuild?: boolean, signal?: AbortSignal, onProgress?: (progress: {completedPages: number, totalPages: number, current?: string}) => void, writeState?: (path: string, content: string) => Promise<void>}} options
 * @returns {Promise<import('../../../shared/types').ComicMergeItem>}
 */
export async function mergeOneComic(
  root,
  relDir,
  { format, raw = false, rebuild = false, signal, onProgress, writeState = writeAtomicTextFile }
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
  let repairedPages = 0
  let stagedOutputPath = null
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
      // 原样 EPUB 通常无须读入图片：sharp 仅读取元数据，yazl 在写入时按需流式读取源文件。
      // 但结构异常的 jpg/jpeg 必须检出并转码修复，否则坏图会原样进入 EPUB（阅读器渲染异常）。
      if (raw) {
        const ext = extOf(path)
        if (isJpegExt(ext)) {
          const buffer = await readBinaryFile(path)
          if (needsJpegRepair(buffer)) {
            const page = await encodeToJpeg(buffer, {
              quality: RAW_JPEG_QUALITY,
              tolerant: true
            })
            repairedPages += 1
            sourceBytes += buffer.length
            return { ...page, sourceBytes: buffer.length, repaired: true }
          }
          const metadata = await sharp(buffer, { limitInputPixels: false }).metadata()
          sourceBytes += buffer.length
          return {
            sourcePath: path,
            width: metadata.width ?? 0,
            height: metadata.height ?? 0,
            ext,
            sourceBytes: buffer.length,
            repaired: false
          }
        }
        const metadata = await sharp(path, { limitInputPixels: false }).metadata()
        const source = await fileSize(path)
        sourceBytes += source
        return {
          sourcePath: path,
          width: metadata.width ?? 0,
          height: metadata.height ?? 0,
          ext,
          sourceBytes: source,
          repaired: false
        }
      }
      const page = await preparePage(path, { format, raw })
      sourceBytes += page.sourceBytes ?? page.data.length
      repairedPages += page.repaired ? 1 : 0
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
      stagedOutputPath = stagingPath
    } catch (error) {
      await discardStagedFile(stagingPath)
      throw error
    }
  } else {
    // pdf-lib 仍需完整序列化，但避免额外保留章节嵌套数组；超大书建议使用 EPUB。
    // 单本内页级转码并行（sharp 转码是 CPU 密集的耗时大头）：pages 按索引填充，
    // 最终顺序与串行完全一致，仅同时驻留在途页 Buffer（上限 PDF_PAGE_CONCURRENCY）。
    const pageSources = []
    for (const chapter of chaptersToProcess) {
      for (const image of chapter.images) pageSources.push(join(comicDir, image))
    }
    const pages = new Array(pageSources.length)
    let pageCursor = 0
    let processedCount = 0
    const pageLane = async () => {
      while (pageCursor < pageSources.length && !signal?.aborted) {
        const index = pageCursor
        pageCursor += 1
        const page = await preparePage(pageSources[index], { format, raw })
        pages[index] = page
        sourceBytes += page.sourceBytes ?? page.data.length
        repairedPages += page.repaired ? 1 : 0
        processedCount += 1
        onProgress?.({
          completedPages: processedCount,
          totalPages: processedPageCount,
          current: comic.name,
          phase: '正在处理 PDF 页面'
        })
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(PDF_PAGE_CONCURRENCY, pageSources.length) }, pageLane)
    )
    if (signal?.aborted) throw new Error('已取消')
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
      stagedOutputPath = stagingPath
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
    const coverBuffer = await readBinaryFile(join(comicDir, comic.chapters[0].images[0]))
    // 封面同源图：坏 JPEG 同样宽容解码修复，否则首图异常会导致整本合并失败
    const cover = await encodeWithRepair(coverBuffer, { quality: 78, maxWidth: COVER_WIDTH })
    await writeBinaryFile(coverPath, cover.data)
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
  if (!stagedOutputPath) throw new Error('漫画产物暂存文件缺失')
  // marker 先持久化“已验证暂存产物 + 目标摘要 + 新清单”。若 commit 后写清单失败，
  // 下次扫描只在目标摘要匹配时补写清单，不会把旧产物误认为已增量追加。
  outputBytes = await fileSize(stagedOutputPath)
  newState.outputBytes = outputBytes
  const outputHash = createHash('sha256').update(await readBinaryFile(stagedOutputPath)).digest('hex')
  const markerPath = join(comicDir, COMIC_STATE_PENDING_NAME)
  await writeAtomicTextFile(
    markerPath,
    JSON.stringify({ version: 1, outputName, outputHash, state: newState }, null, 2)
  )
  try {
    await commitStagedFile(stagedOutputPath, outputPath)
    outputBytes = await fileSize(outputPath)
    await writeState(join(comicDir, COMIC_STATE_NAME), JSON.stringify(newState, null, 2))
    await discardStagedFile(markerPath)
  } catch (error) {
    // 已提交的产物保留 marker，留待下次扫描按摘要安全恢复清单。
    if (await pathExists(stagedOutputPath)) await discardStagedFile(stagedOutputPath)
    throw error
  }

  return {
    relDir,
    name: comic.name,
    mode,
    outputName,
    chapters: chaptersToProcess.length,
    images: chaptersToProcess.reduce((sum, chapter) => sum + chapter.images.length, 0),
    bytes: outputBytes,
    sourceBytes,
    repairedPages
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

  // 预先扫描以获得稳定的页数总量；这让数千页长漫画能显示实际页进度，而非只显示“第几本”。
  // 扫描本身也是大量目录 I/O，车道并发 4 缩短「准备」阶段等待，取消从任务创建前就生效。
  const plans = []
  let scanCursor = 0
  const scanLane = async () => {
    while (scanCursor < relDirs.length) {
      throwIfAborted(signal)
      const relDir = relDirs[scanCursor]
      scanCursor += 1
      const comic = await scanComic(root, relDir)
      const update = !rebuild && comic.merged?.format === format
      const chapters = update ? comic.newChapters : comic.chapters
      plans.push({
        relDir,
        total: chapters.reduce((sum, chapter) => sum + chapter.images.length, 0)
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, relDirs.length) }, scanLane))
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
    // 单部漫画内部已做页级并行转码；同时并行多部超大 PDF 会成倍放大 pdf-lib 的全量内存占用。
    // EPUB 至多 4 本并行（sharp 转码是 CPU 密集，多本并行充分利用多核）；
    // PDF 保持单本并行（页级并行已提速），优先保证 Windows 的稳定性。
    concurrency: format === 'pdf' ? 1 : Math.min(4, concurrency),
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
  for (let index = 0; index < result.results.length; index += 1) {
    const entry = result.results[index]
    if (!entry.ok && !entry.cancelled) {
      const target = relDirs[index]
      const sourcePath = join(root, target)
      let movedTo = null
      let moveError = null
      if (await pathExists(sourcePath)) {
        try {
          const failDir = join(root, COMIC_FAILED_DIR_NAME)
          const destination = await moveWithCollision(sourcePath, failDir)
          movedTo = relative(root, destination)
        } catch (err) {
          moveError = err instanceof Error ? err.message : String(err)
        }
      }
      report.failed.push({
        target,
        error: entry.error ?? '未知错误',
        movedTo,
        moveError
      })
    }
  }
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
