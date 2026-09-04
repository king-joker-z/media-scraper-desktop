import { join, relative } from 'node:path'
import sharp from 'sharp'
import { COMIC_STATE_PENDING_NAME, isComicSnapshotCurrent, scanComic } from './scan.mjs'
import { appendEpubFile, createEpubFile, verifyEpubFile } from './epub.mjs'
import { appendPdf, createPdf, verifyPdfFile } from './pdf.mjs'
import { createNativePdfFile } from './pdf-native.mjs'
import {
  commitStagedFile,
  createStagingPath,
  discardStagedFile,
  fileSize,
  moveWithCollision,
  pathExists,
  readBinaryFile,
  removeEmptyDirs,
  sha256File,
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
 * - PDF 质量预设仅 raw / balanced；增量追加时二者切换必须全量重建；
 *   旧清单 high/text 视为脏状态，自动全量重建并按 balanced 处理；
 * - 有损预处理统一应用 EXIF 方向并转换到 sRGB，透明图先铺白色后 JPEG 编码；
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
export const PDF_QUALITY_PRESETS = {
  raw: { label: '原样', maxWidth: 0, quality: RAW_JPEG_QUALITY, chromaSubsampling: '4:2:0' },
  balanced: {
    label: '默认优化',
    maxWidth: OPT_MAX_WIDTH,
    quality: OPT_JPEG_QUALITY,
    chromaSubsampling: '4:2:0'
  }
}

/**
 * 归一化 PDF 质量。原样复选框或显式 raw 才走无损直嵌；
 * 已移除的 high/text 以及未知值一律按历史默认 balanced 处理。
 * @param {unknown} pdfQuality
 * @param {boolean} [raw]
 * @returns {'raw'|'balanced'}
 */
export function resolvePdfQuality(pdfQuality, raw = false) {
  if (raw === true || pdfQuality === 'raw') return 'raw'
  return 'balanced'
}

/** 清单写入了已移除的 high/text 等档位时，不能与当前页面混排增量。 */
const hasLegacyPdfQuality = (state, format) => {
  if (format !== 'pdf' || !state) return false
  const previous = state.pdfQuality ?? 'balanced'
  return !Object.hasOwn(PDF_QUALITY_PRESETS, previous)
}

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw new Error('已取消')
}

const extOf = (name) => {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index + 1).toLowerCase()
}

const isJpegExt = (ext) => ext === 'jpg' || ext === 'jpeg'

/**
 * 原样 JPEG 只有在已明确识别为 3 通道 sRGB、没有 EXIF 方向变换时才能直嵌流式 PDF。
 * CMYK、灰度、带方向变换或无法识别色彩空间的 JPEG 交给 pdf-lib，以免错误以 DeviceRGB
 * 解释 DCT 数据。Sharp 在这里只读取元数据，不参与 PDF 生成。
 * 读取失败（坏图告警升级抛错）返回 false，回退兼容模式由逐页修复处理。
 */
const supportsStreamRawJpeg = async (path) => {
  try {
    if (!isJpegExt(extOf(path))) return false
    const metadata = await sharp(path, { limitInputPixels: false }).metadata()
    return (
      metadata.format === 'jpeg' &&
      (metadata.orientation ?? 1) === 1 &&
      metadata.space === 'srgb' &&
      metadata.channels === 3
    )
  } catch {
    return false
  }
}

// sharp 0.35 默认 failOn='warning'：libjpeg 对「标记前有多余字节」等坏 JPEG 告警会直接抛错，
// 分块存储的 TIFF（瓦片损坏时报「error in tile 0 x 0 … read gave 1 warnings」）等其它加载器
// 的告警也会被升级为异常，导致漫画合并整本失败。此正则识别这类可宽容解码修复的错误
// （严格解码失败时降级 failOn='none' 重试），导出供单测覆盖真实报错样本。
export const isRepairableJpegError = (error) =>
  /VipsJpeg|Corrupt JPEG data|extraneous bytes|Premature end of JPEG|Warning treated as error|error in tile|read gave \d+ warnings/i.test(
    String(error?.message ?? error)
  )

/**
 * 读取图片元数据。坏图的告警可能被 sharp 默认 failOn='warning' 升级为异常（极端情况下
 * 仅读头也会触发），此时返回 null，由调用方决定是否走宽容解码转码修复。
 */
async function readMetadataSafe(input) {
  try {
    return await sharp(input, { limitInputPixels: false }).metadata()
  } catch (error) {
    if (isRepairableJpegError(error)) return null
    throw error
  }
}

/**
 * 经 sharp 编码为 JPEG。宽容模式（failOn:'none'）让 libjpeg 跳过垃圾字节完成解码，
 * 相当于把结构异常的坏图修复为干净 JPEG（像素与严格解码一致，见 test/jpeg-guard.test.mjs）。
 * @param {Buffer} buffer
 * @param {{quality: number, maxWidth?: number, chromaSubsampling?: '4:2:0'|'4:4:4', tolerant?: boolean}} options
 */
async function encodeToJpeg(
  buffer,
  { quality, maxWidth = 0, chromaSubsampling = '4:2:0', tolerant = false }
) {
  const options = { limitInputPixels: false }
  if (tolerant) options.failOn = 'none'
  let pipeline = sharp(buffer, options)
  const metadata = await pipeline.metadata()
  // rotate 在解码链中应用 EXIF Orientation；有损输出统一 sRGB，避免不同阅读器色彩解释不一致。
  pipeline = pipeline.rotate().toColorspace('srgb')
  if (maxWidth > 0) {
    pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true })
  }
  if (metadata.hasAlpha) pipeline = pipeline.flatten({ background: '#ffffff' })
  const { data, info } = await pipeline
    .jpeg({ quality, chromaSubsampling, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, ext: 'jpg' }
}

/**
 * 严格解码，命中坏 JPEG（libjpeg 告警级，sharp 默认 failOn='warning' 会抛错）时
 * 降级为宽容解码修复。
 * @returns {{data: Buffer, width: number, height: number, ext: string, repaired: boolean}}
 */
async function encodeWithRepair(buffer, { quality, maxWidth = 0, chromaSubsampling = '4:2:0' }) {
  try {
    return {
      ...(await encodeToJpeg(buffer, { quality, maxWidth, chromaSubsampling })),
      repaired: false
    }
  } catch (error) {
    if (isRepairableJpegError(error)) {
      return {
        ...(await encodeToJpeg(buffer, { quality, maxWidth, chromaSubsampling, tolerant: true })),
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
 * @param {{format: 'epub'|'pdf', raw: boolean, pdfQuality?: 'raw'|'balanced'|string}} options
 */
export async function prepareComicPage(absPath, { format, raw, pdfQuality = 'balanced' }) {
  const buffer = await readBinaryFile(absPath)
  const sourceExt = extOf(absPath)
  pdfQuality = resolvePdfQuality(pdfQuality, raw)

  if (raw && (format === 'epub' || PDF_DIRECT_EXTS.has(sourceExt))) {
    if (isJpegExt(sourceExt) && needsJpegRepair(buffer)) {
      return {
        ...(await encodeToJpeg(buffer, { quality: RAW_JPEG_QUALITY, tolerant: true })),
        repaired: true,
        sourceBytes: buffer.length
      }
    }
    const metadata = await readMetadataSafe(buffer)
    if (!metadata) {
      // 结构扫描未见异常但解码仍告警（如瓦片损坏）：宽容解码转码为干净 JPEG
      return {
        ...(await encodeToJpeg(buffer, { quality: RAW_JPEG_QUALITY, tolerant: true })),
        repaired: true,
        sourceBytes: buffer.length
      }
    }
    return {
      data: buffer,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      ext: sourceExt === 'jpeg' ? 'jpg' : sourceExt,
      sourceBytes: buffer.length,
      repaired: false
    }
  }

  const profile = format === 'pdf' ? PDF_QUALITY_PRESETS[pdfQuality] : PDF_QUALITY_PRESETS.balanced
  const quality = raw ? RAW_JPEG_QUALITY : profile.quality
  const page = await encodeWithRepair(buffer, {
    quality,
    maxWidth: raw ? 0 : profile.maxWidth,
    chromaSubsampling: profile.chromaSubsampling
  })
  return { ...page, sourceBytes: buffer.length }
}

/**
 * 合并单部漫画。
 * @param {string} root 工作区
 * @param {string} relDir 漫画相对目录
 * @param {{format: 'epub'|'pdf', raw?: boolean, pdfQuality?: 'raw'|'balanced'|string, rebuild?: boolean, signal?: AbortSignal, onProgress?: (progress: {completedPages: number, totalPages: number, current?: string}) => void, writeState?: (path: string, content: string) => Promise<void>}} options
 * @returns {Promise<import('../../../shared/types').ComicMergeItem>}
 */
export async function mergeOneComic(
  root,
  relDir,
  {
    format,
    raw = false,
    pdfQuality,
    rebuild = false,
    comic: plannedComic,
    pageConcurrency = 2,
    signal,
    onProgress,
    writeState = writeAtomicTextFile
  }
) {
  pdfQuality = resolvePdfQuality(pdfQuality, raw)
  const useRaw = format === 'pdf' ? pdfQuality === 'raw' : raw
  const startedAt = Date.now()
  let preprocessDurationMs = 0
  let documentDurationMs = 0
  let verifyDurationMs = 0
  // 预扫描快照只在目录及每张图片的元数据均未变化时复用；否则完整重扫。
  const comic =
    plannedComic && (await isComicSnapshotCurrent(root, relDir, plannedComic.snapshot, { signal }))
      ? plannedComic
      : await scanComic(root, relDir, { signal })
  const comicDir = join(root, relDir)
  // 旧 PDF 清单 high/text：不能增量混页，忽略既有清单并按当前 raw/balanced 全量重建。
  const state = rebuild || hasLegacyPdfQuality(comic.merged, format) ? null : comic.merged

  if (comic.imageCount === 0 && !state) throw new Error('没有可合并的图片')
  if (state && state.format !== format) {
    // 换格式必须全量重建（EPUB/PDF 结构不同，无法互转追加）
  } else if (state) {
    if (format === 'pdf' && (state.pdfQuality ?? 'balanced') !== pdfQuality) {
      throw new Error('PDF 质量预设已变化，请勾选全量重建后重试')
    }
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
  let pdfEngine = null
  let pdfFallbackReason = null
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
      if (useRaw) {
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
          const metadata = await readMetadataSafe(buffer)
          if (!metadata) {
            const page = await encodeToJpeg(buffer, {
              quality: RAW_JPEG_QUALITY,
              tolerant: true
            })
            repairedPages += 1
            sourceBytes += buffer.length
            return { ...page, sourceBytes: buffer.length, repaired: true }
          }
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
        const metadata = await readMetadataSafe(path)
        if (!metadata) {
          // 无法确认元数据的坏图（如瓦片损坏）：宽容解码转码为干净 JPEG，避免整本失败
          const buffer = await readBinaryFile(path)
          const page = await encodeToJpeg(buffer, { quality: RAW_JPEG_QUALITY, tolerant: true })
          repairedPages += 1
          sourceBytes += buffer.length
          return { ...page, sourceBytes: buffer.length, repaired: true }
        }
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
      const page = await prepareComicPage(path, { format, raw: useRaw, pdfQuality })
      sourceBytes += page.sourceBytes ?? page.data.length
      repairedPages += page.repaired ? 1 : 0
      return page
    }
    const documentStartedAt = Date.now()
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
      documentDurationMs = Date.now() - documentStartedAt
      if (signal?.aborted) throw new Error('已取消')
      onProgress?.({
        completedPages: processedPageCount,
        totalPages: processedPageCount,
        current: comic.name,
        phase: '正在校验 EPUB 结构并安全替换产物'
      })
      const verifyStartedAt = Date.now()
      await verifyEpubFile(stagingPath, expectedPages)
      verifyDurationMs = Date.now() - verifyStartedAt
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
    const expectedPages =
      (mode === 'update'
        ? state.chapters.reduce((sum, chapter) => sum + chapter.images.length, 0)
        : 0) + pageSources.length
    const stagingPath = createStagingPath(outputPath)
    try {
      const documentStartedAt = Date.now()
      const streamRawCompatible =
        !useRaw || (await Promise.all(pageSources.map(supportsStreamRawJpeg))).every(Boolean)
      const useStreaming = mode === 'full' && streamRawCompatible
      if (!useStreaming) {
        pdfFallbackReason =
          mode === 'update'
            ? '增量追加需保留既有 PDF 页面，使用兼容模式'
            : '原样模式含非 sRGB 三通道 JPEG、EXIF 方向图或无法确认的 JPEG，使用兼容模式'
      }
      const writePdfLib = async () => {
        const pages = new Array(pageSources.length)
        let pageCursor = 0
        let processedCount = 0
        const pageLane = async () => {
          while (pageCursor < pageSources.length && !signal?.aborted) {
            const index = pageCursor
            pageCursor += 1
            const page = await prepareComicPage(pageSources[index], {
              format,
              raw: useRaw,
              pdfQuality
            })
            pages[index] = page
            sourceBytes += page.sourceBytes ?? page.data.length
            repairedPages += page.repaired ? 1 : 0
            processedCount += 1
            onProgress?.({
              completedPages: processedCount,
              totalPages: processedPageCount,
              current: comic.name,
              phase: '正在处理 PDF 页面（兼容模式）'
            })
          }
        }
        const preprocessStartedAt = Date.now()
        await Promise.all(
          Array.from({ length: Math.min(pageConcurrency, pageSources.length) }, pageLane)
        )
        preprocessDurationMs = Date.now() - preprocessStartedAt
        throwIfAborted(signal)
        const bytes =
          mode === 'update'
            ? await appendPdf(await readBinaryFile(outputPath), { pages })
            : await createPdf({ title: comic.name, pages })
        await writeBinaryFile(stagingPath, bytes)
        pdfEngine = 'pdf-lib'
      }
      if (useStreaming) {
        let processedCount = 0
        const pages = (async function* () {
          for (const source of pageSources) {
            throwIfAborted(signal)
            const page = await prepareComicPage(source, { format, raw: useRaw, pdfQuality })
            sourceBytes += page.sourceBytes ?? page.data.length
            repairedPages += page.repaired ? 1 : 0
            processedCount += 1
            onProgress?.({
              completedPages: processedCount,
              totalPages: processedPageCount,
              current: comic.name,
              phase: '正在流式写入 PDF 页面'
            })
            yield page
          }
        })()
        preprocessDurationMs = 0
        try {
          await createNativePdfFile({
            outputPath: stagingPath,
            title: comic.name,
            pageCount: pageSources.length,
            pages,
            signal
          })
          pdfEngine = 'stream-pdf'
        } catch (error) {
          if (signal?.aborted) throw error
          await discardStagedFile(stagingPath)
          pdfFallbackReason = `流式 PDF 写入失败，已回退兼容模式：${
            error instanceof Error ? error.message : String(error)
          }`
          // 原生迭代器可能已消费部分页面；兼容路径从源文件重新读取，确保页序完整。
          sourceBytes = 0
          repairedPages = 0
          await writePdfLib()
        }
      } else {
        await writePdfLib()
      }
      documentDurationMs = Date.now() - documentStartedAt
      if (signal?.aborted) throw new Error('已取消')
      onProgress?.({
        completedPages: processedPageCount,
        totalPages: processedPageCount,
        current: comic.name,
        phase: '正在校验 PDF 文档'
      })
      const verifyStartedAt = Date.now()
      await verifyPdfFile(stagingPath, expectedPages)
      verifyDurationMs = Date.now() - verifyStartedAt
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
    ...(format === 'pdf' ? { pdfQuality } : {}),
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
  const outputHash = await sha256File(stagedOutputPath)
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
    repairedPages,
    ...(format === 'pdf'
      ? {
          pdfQuality,
          pdfEngine,
          ...(pdfFallbackReason ? { pdfFallbackReason } : {}),
          preprocessDurationMs,
          documentDurationMs,
          verifyDurationMs,
          durationMs: Date.now() - startedAt
        }
      : { durationMs: Date.now() - startedAt, documentDurationMs, verifyDurationMs })
  }
}

/**
 * 批量合并（TaskCenter 并发，一项一部漫画）。
 * @param {string} root
 * @param {{relDirs: string[], format: 'epub'|'pdf', raw?: boolean, pdfQuality?: 'raw'|'balanced'|string, rebuild?: boolean, snapshots?: object[], taskCenter: object, taskId: string, bookConcurrency?: number, pageConcurrency?: number, signal?: AbortSignal, onProgress?: (progress: {completed: number, total: number, current: string, done?: boolean, cancelled?: boolean}) => void}} options
 * @returns {Promise<import('../../../shared/types').ComicMergeReport>}
 */
export async function mergeComics(
  root,
  {
    relDirs,
    format,
    raw = false,
    pdfQuality,
    rebuild = false,
    taskCenter,
    taskId,
    snapshots = [],
    bookConcurrency = 2,
    pageConcurrency = 2,
    signal,
    onProgress
  }
) {
  pdfQuality = resolvePdfQuality(pdfQuality, raw)
  const startedAt = Date.now()
  const report = { taskId, cancelled: false, format, merged: [], failed: [], durationMs: 0 }

  if (relDirs.length === 0) {
    report.durationMs = Date.now() - startedAt
    return report
  }

  // 预先扫描以获得稳定的页数总量；这让数千页长漫画能显示实际页进度，而非只显示“第几本”。
  // 扫描本身也是大量目录 I/O，车道并发 4 缩短「准备」阶段等待，取消从任务创建前就生效。
  const suppliedByRelDir = new Map(
    snapshots
      .filter((comic) => comic?.relDir && relDirs.includes(comic.relDir))
      .map((comic) => [comic.relDir, comic])
  )
  const plans = []
  let scanCursor = 0
  const scanLane = async () => {
    while (scanCursor < relDirs.length) {
      throwIfAborted(signal)
      const relDir = relDirs[scanCursor]
      scanCursor += 1
      const supplied = suppliedByRelDir.get(relDir)
      const comic =
        supplied && (await isComicSnapshotCurrent(root, relDir, supplied.snapshot, { signal }))
          ? supplied
          : await scanComic(root, relDir, { signal })
      const update =
        !rebuild && !hasLegacyPdfQuality(comic.merged, format) && comic.merged?.format === format
      const chapters = update ? comic.newChapters : comic.chapters
      plans.push({
        relDir,
        comic,
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
    // PDF 保持单本并行（页级并行已提速），优先保证 Windows 的稳定性。
    concurrency: format === 'pdf' ? 1 : bookConcurrency,
    signal,
    worker: async (relDir, signal) => {
      if (signal?.aborted) throw new Error('已取消')
      const item = await mergeOneComic(root, relDir, {
        format,
        raw,
        pdfQuality,
        rebuild,
        comic: plans.find((plan) => plan.relDir === relDir)?.comic,
        pageConcurrency,
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
