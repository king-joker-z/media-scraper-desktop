import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/**
 * EPUB 3 漫画书构建器（纯 JS，fflate 实现 zip）：
 * - 一图一页 XHTML（fixed-layout viewport，阅读器满屏显示）；
 * - nav.xhtml 章节导航（每章链接到本章第一页）；
 * - 图片 entries 以 STORE 存储（JPEG/PNG 本身已压缩，deflate 无收益反而拖慢）；
 * - 支持增量追加：解包既有 EPUB，保留原页面，新章节页码续编，重写 OPF/nav 后重打包。
 *
 * 页面对象：{ data: Uint8Array, width: number, height: number, ext: 'jpg'|'png'|'webp'|'gif' }
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

/** 打包：mimetype 必须为首 entry 且不压缩；图片 STORE；文本 deflate。 */
function packEpub(files, imageKeys) {
  const imageSet = new Set(imageKeys)
  const entries = {}
  entries.mimetype = [strToU8('application/epub+zip'), { level: 0 }]
  for (const [path, data] of Object.entries(files)) {
    entries[path] = imageSet.has(path) ? [data, { level: 0 }] : [data, { level: 6 }]
  }
  return zipSync(entries)
}

/**
 * 新建 EPUB。
 * @param {{title: string, chapters: Array<{name: string, pages: Array}>}} input
 * @returns {Uint8Array}
 */
export function createEpub({ title, chapters }) {
  const files = {}
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
  files['META-INF/container.xml'] = strToU8(CONTAINER_XML)
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

/**
 * 增量追加：在既有 EPUB 末尾续编新章节（页码接续，原页面字节级保留）。
 * @param {Uint8Array} existingBytes 既有 EPUB 内容
 * @param {{title: string, existingChapters: Array<{name: string, pageCount: number}>, newChapters: Array<{name: string, pages: Array}>}} input
 * @returns {Uint8Array}
 */
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
  imageKeys.sort()

  // 既有章节页码区间：按清单顺序从 1 顺推（本工具生成的 EPUB 一章内页码连续）
  const chapterRanges = []
  let pageIndex = 0
  for (const chapter of existingChapters) {
    chapterRanges.push({ name: chapter.name, start: pageIndex + 1, count: chapter.pageCount })
    pageIndex += chapter.pageCount
  }
  // 以 zip 内实际页面数为准（防清单与产物不一致时页码错乱）
  const actualPages = Object.keys(files).filter((path) =>
    /^OEBPS\/text\/p\d+\.xhtml$/.test(path)
  ).length
  pageIndex = Math.max(pageIndex, actualPages)

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

/** 读取 EPUB 内页面数（测试与校验用） */
export function countEpubPages(bytes) {
  const files = unzipSync(bytes)
  return Object.keys(files).filter((path) => /^OEBPS\/text\/p\d+\.xhtml$/.test(path)).length
}

/** 读取 EPUB 章节导航条目（测试用） */
export function listEpubNavItems(bytes) {
  const files = unzipSync(bytes)
  const nav = files['OEBPS/nav.xhtml']
  if (!nav) return []
  return [...strFromU8(nav).matchAll(/<a href="text\/p\d+\.xhtml">([^<]+)<\/a>/g)].map(
    (match) => match[1]
  )
}
