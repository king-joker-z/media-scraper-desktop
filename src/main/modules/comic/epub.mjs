import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import yazl from 'yazl'
import yauzl from 'yauzl'
import { writeReadableFile } from '../../core/fs-ops.mjs'

/**
 * EPUB 3 漫画书构建器。
 * 同步 API 保留给既有测试；大文件合并使用下方 createEpubFile/appendEpubFile，
 * 逐页写入 ZIP，内存只保留当前图片与轻量目录清单。
 */

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif'
}

const escapeXml = (text) =>
  String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const pageId = (index) => `p${String(index).padStart(5, '0')}`
const isImagePath = (path) => /^OEBPS\/images\/p\d+\.\w+$/.test(path)
const isTextPath = (path) => /^OEBPS\/text\/p\d+\.xhtml$/.test(path)

const CONTAINER_XML = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`

const pageXhtml = (id, ext, width, height, title) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapeXml(title)}</title>
  <meta name="viewport" content="width=${width}, height=${height}"/>
  <style>html,body{margin:0;padding:0;}img{display:block;width:100%;height:auto;}</style>
</head>
<body><img src="../images/${id}.${ext}" alt="${id}"/></body>
</html>
`

const navXhtml = (title, chapterRanges) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeXml(title)}</title></head>
<body>
<nav epub:type="toc">
  <h1>${escapeXml(title)}</h1>
  <ol>
${chapterRanges
  .map(
    (chapter) =>
      `    <li><a href="text/${pageId(chapter.start)}.xhtml">${escapeXml(chapter.name)}</a></li>`
  )
  .join('\n')}
  </ol>
</nav>
</body>
</html>
`

const contentOpf = (
  title,
  identifier,
  modified,
  imageItems,
  pageCount
) => `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${identifier}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${imageItems
  .map(
    (item) =>
      `    <item id="i-${item.id}" href="images/${item.id}.${item.ext}" media-type="${MIME_BY_EXT[item.ext] ?? 'application/octet-stream'}"/>`
  )
  .join('\n')}
${Array.from(
  { length: pageCount },
  (_, index) =>
    `    <item id="t-${pageId(index + 1)}" href="text/${pageId(index + 1)}.xhtml" media-type="application/xhtml+xml"/>`
).join('\n')}
  </manifest>
  <spine>
${Array.from(
  { length: pageCount },
  (_, index) => `    <itemref idref="t-${pageId(index + 1)}"/>`
).join('\n')}
  </spine>
</package>
`

const metadataBuffer = (text) => Buffer.from(text, 'utf8')
const throwIfAborted = (signal) => {
  if (signal?.aborted) throw new Error('已取消')
}

function addBookPreamble(zip) {
  // EPUB 规范要求 mimetype 是第一个且未压缩的 ZIP entry。
  zip.addBuffer(metadataBuffer('application/epub+zip'), 'mimetype', { compress: false })
  zip.addBuffer(metadataBuffer(CONTAINER_XML), 'META-INF/container.xml')
}

function addBookMetadata(zip, { title, chapterRanges, imageItems, pageCount }) {
  zip.addBuffer(metadataBuffer(navXhtml(title, chapterRanges)), 'OEBPS/nav.xhtml')
  zip.addBuffer(
    metadataBuffer(
      contentOpf(
        title,
        crypto.randomUUID(),
        new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        imageItems,
        pageCount
      )
    ),
    'OEBPS/content.opf'
  )
}

async function writeZip(outputPath, populate) {
  const zip = new yazl.ZipFile()
  const writing = writeReadableFile(outputPath, zip.outputStream)
  try {
    await populate(zip)
    zip.end()
    await writing
  } catch (error) {
    zip.outputStream.destroy(error)
    await writing.catch(() => {})
    throw error
  }
}

/**
 * 向流式 EPUB 添加页面。preparePage 仅返回当前页数据，调用完成后不保留该数据，
 * 因此数千页长漫画也不会形成 Buffer 数组。
 */
async function addChapters(
  zip,
  {
    title,
    chapters,
    pageIndex = 0,
    preparePage,
    signal,
    onProgress,
    totalPages,
    initialRanges = [],
    initialImages = []
  }
) {
  const chapterRanges = [...initialRanges]
  const imageItems = [...initialImages]
  let completedPages = pageIndex
  for (const chapter of chapters) {
    throwIfAborted(signal)
    const start = pageIndex + 1
    for (const page of chapter.pages) {
      throwIfAborted(signal)
      const prepared = await preparePage(page)
      throwIfAborted(signal)
      pageIndex += 1
      completedPages += 1
      const id = pageId(pageIndex)
      const imagePath = `OEBPS/images/${id}.${prepared.ext}`
      // 原样模式仅登记源文件路径，yazl 在输出阶段按需读取，避免将数千张原图堆入 JS 堆。
      if (prepared.sourcePath) zip.addFile(prepared.sourcePath, imagePath, { compress: false })
      else zip.addBuffer(prepared.data, imagePath, { compress: false })
      zip.addBuffer(
        metadataBuffer(pageXhtml(id, prepared.ext, prepared.width, prepared.height, title)),
        `OEBPS/text/${id}.xhtml`
      )
      imageItems.push({ id, ext: prepared.ext })
      onProgress?.({ completedPages, totalPages })
    }
    chapterRanges.push({ name: chapter.name, start, count: chapter.pages.length })
  }
  return { chapterRanges, imageItems, pageCount: pageIndex }
}

/** 全量流式创建 EPUB。章节页为任意描述对象，由 preparePage 按需读取/转码。 */
export async function createEpubFile({
  outputPath,
  title,
  chapters,
  preparePage,
  signal,
  onProgress
}) {
  const totalPages = chapters.reduce((sum, chapter) => sum + chapter.pages.length, 0)
  await writeZip(outputPath, async (zip) => {
    addBookPreamble(zip)
    const result = await addChapters(zip, {
      title,
      chapters,
      preparePage,
      signal,
      onProgress,
      totalPages
    })
    addBookMetadata(zip, { title, ...result })
  })
}

function listZipEntries(sourcePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      sourcePath,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true },
      (error, zip) => {
        if (error) return reject(error)
        const entries = []
        zip.on('error', reject)
        zip.on('entry', (entry) => {
          if (/\/$/.test(entry.fileName)) {
            zip.readEntry()
            return
          }
          entries.push(entry)
          zip.readEntry()
        })
        zip.on('end', () => resolve({ zip, entries }))
        zip.readEntry()
      }
    )
  })
}

function addExistingEntry(zip, sourceZip, entry) {
  return new Promise((resolve, reject) => {
    zip.addReadStreamLazy(
      entry.fileName,
      { compress: false, size: entry.uncompressedSize },
      (callback) => {
        sourceZip.openReadStream(entry, (error, stream) => {
          if (error) {
            callback(error)
            reject(error)
            return
          }
          stream.once('error', reject)
          stream.once('end', resolve)
          callback(null, stream)
        })
      }
    )
  })
}

/**
 * 流式追加 EPUB：旧书逐 entry 解压复制，旧图片不进入 JS 大 Buffer、也不重编码。
 * 因 ZIP 中目录在尾部，追加会重写容器，但内存与旧书体积无关。
 */
export async function appendEpubFile({
  sourcePath,
  outputPath,
  title,
  existingChapters,
  newChapters,
  preparePage,
  signal,
  onProgress
}) {
  const { zip: sourceZip, entries } = await listZipEntries(sourcePath)
  const oldImages = entries
    .filter((entry) => isImagePath(entry.fileName))
    .map((entry) => {
      const match = /^OEBPS\/images\/(p\d+)\.(\w+)$/.exec(entry.fileName)
      return { id: match[1], ext: match[2] }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  const oldPages = entries.filter((entry) => isTextPath(entry.fileName)).length
  const statePages = existingChapters.reduce((sum, chapter) => sum + chapter.pageCount, 0)
  if (oldPages === 0 || oldImages.length !== oldPages || oldPages !== statePages) {
    sourceZip.close()
    throw new Error('既有 EPUB 与合并清单不一致，请勾选全量重建后重试')
  }

  const initialRanges = []
  let cursor = 0
  for (const chapter of existingChapters) {
    initialRanges.push({ name: chapter.name, start: cursor + 1, count: chapter.pageCount })
    cursor += chapter.pageCount
  }
  const totalPages = oldPages + newChapters.reduce((sum, chapter) => sum + chapter.pages.length, 0)
  try {
    await writeZip(outputPath, async (zip) => {
      addBookPreamble(zip)
      for (const entry of entries) {
        throwIfAborted(signal)
        if (
          entry.fileName === 'mimetype' ||
          entry.fileName === 'META-INF/container.xml' ||
          entry.fileName === 'OEBPS/content.opf' ||
          entry.fileName === 'OEBPS/nav.xhtml'
        ) {
          continue
        }
        await addExistingEntry(zip, sourceZip, entry)
      }
      const result = await addChapters(zip, {
        title,
        chapters: newChapters,
        pageIndex: oldPages,
        preparePage,
        signal,
        onProgress,
        totalPages,
        initialRanges,
        initialImages: oldImages
      })
      addBookMetadata(zip, { title, ...result })
    })
  } finally {
    sourceZip.close()
  }
}

/** 轻量结构校验：确认 EPUB 可读取且关键 entry、页数均完整。 */
export async function verifyEpubFile(sourcePath, expectedPages) {
  const { zip, entries } = await listZipEntries(sourcePath)
  try {
    const names = new Set(entries.map((entry) => entry.fileName))
    const pages = entries.filter((entry) => isTextPath(entry.fileName)).length
    const images = entries.filter((entry) => isImagePath(entry.fileName)).length
    if (
      !names.has('mimetype') ||
      !names.has('META-INF/container.xml') ||
      !names.has('OEBPS/content.opf') ||
      !names.has('OEBPS/nav.xhtml') ||
      pages !== expectedPages ||
      images !== expectedPages
    ) {
      throw new Error('EPUB 完整性校验失败，未替换原产物')
    }
    return true
  } finally {
    zip.close()
  }
}

/* 兼容小型单元测试的内存 API；主流程不可使用。 */
function packEpub(files, imageKeys) {
  const imageSet = new Set(imageKeys)
  const entries = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] }
  for (const [path, data] of Object.entries(files)) {
    entries[path] = imageSet.has(path) ? [data, { level: 0 }] : [data, { level: 6 }]
  }
  return zipSync(entries)
}

export function createEpub({ title, chapters }) {
  const files = { 'META-INF/container.xml': strToU8(CONTAINER_XML) }
  const imageKeys = []
  const imageItems = []
  const chapterRanges = []
  let pageIndex = 0
  for (const chapter of chapters) {
    const start = pageIndex + 1
    for (const page of chapter.pages) {
      pageIndex += 1
      const id = pageId(pageIndex)
      const imagePath = `OEBPS/images/${id}.${page.ext}`
      files[imagePath] = page.data
      files[`OEBPS/text/${id}.xhtml`] = strToU8(
        pageXhtml(id, page.ext, page.width, page.height, title)
      )
      imageKeys.push(imagePath)
      imageItems.push({ id, ext: page.ext })
    }
    chapterRanges.push({ name: chapter.name, start, count: chapter.pages.length })
  }
  files['OEBPS/nav.xhtml'] = strToU8(navXhtml(title, chapterRanges))
  files['OEBPS/content.opf'] = strToU8(
    contentOpf(
      title,
      crypto.randomUUID(),
      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      imageItems,
      pageIndex
    )
  )
  return packEpub(files, imageKeys)
}

export function appendEpub(existingBytes, { title, existingChapters, newChapters }) {
  const unzipped = unzipSync(existingBytes)
  const files = {}
  const imageKeys = []
  const imageItems = []
  for (const [path, data] of Object.entries(unzipped)) {
    if (path === 'mimetype' || path === 'OEBPS/content.opf' || path === 'OEBPS/nav.xhtml') continue
    files[path] = data
    const match = /^OEBPS\/images\/(p\d+)\.(\w+)$/.exec(path)
    if (match) {
      imageKeys.push(path)
      imageItems.push({ id: match[1], ext: match[2] })
    }
  }
  imageItems.sort((a, b) => a.id.localeCompare(b.id))
  const chapterRanges = []
  let pageIndex = 0
  for (const chapter of existingChapters) {
    chapterRanges.push({ name: chapter.name, start: pageIndex + 1, count: chapter.pageCount })
    pageIndex += chapter.pageCount
  }
  pageIndex = Math.max(pageIndex, Object.keys(files).filter(isTextPath).length)
  for (const chapter of newChapters) {
    const start = pageIndex + 1
    for (const page of chapter.pages) {
      pageIndex += 1
      const id = pageId(pageIndex)
      const imagePath = `OEBPS/images/${id}.${page.ext}`
      files[imagePath] = page.data
      files[`OEBPS/text/${id}.xhtml`] = strToU8(
        pageXhtml(id, page.ext, page.width, page.height, title)
      )
      imageKeys.push(imagePath)
      imageItems.push({ id, ext: page.ext })
    }
    chapterRanges.push({ name: chapter.name, start, count: chapter.pages.length })
  }
  files['OEBPS/nav.xhtml'] = strToU8(navXhtml(title, chapterRanges))
  files['OEBPS/content.opf'] = strToU8(
    contentOpf(
      title,
      crypto.randomUUID(),
      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      imageItems,
      pageIndex
    )
  )
  return packEpub(files, imageKeys)
}

export function countEpubPages(bytes) {
  return Object.keys(unzipSync(bytes)).filter(isTextPath).length
}

export function listEpubNavItems(bytes) {
  const nav = unzipSync(bytes)['OEBPS/nav.xhtml']
  if (!nav) return []
  return [...strFromU8(nav).matchAll(/<a href="text\/p\d+\.xhtml">([^<]+)<\/a>/g)].map(
    (match) => match[1]
  )
}
