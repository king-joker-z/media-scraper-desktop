import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import test from 'node:test'
import assert from 'node:assert/strict'
import { unzipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { createTaskCenter } from '../src/main/core/task-center.mjs'
import { sha256File } from '../src/main/core/fs-ops.mjs'
import {
  appendEpub,
  appendEpubFile,
  countEpubPages,
  createEpubFile,
  createEpub,
  listEpubNavItems,
  verifyEpubFile
} from '../src/main/modules/comic/epub.mjs'
import { appendPdf, createPdf, verifyPdfFile } from '../src/main/modules/comic/pdf.mjs'
import {
  buildNativePdfPageObjects,
  createNativePdfFile,
  verifyNativePdfFile
} from '../src/main/modules/comic/pdf-native.mjs'
import {
  deleteComicSources,
  mergeComics,
  mergeOneComic,
  prepareComicPage,
  resolvePdfQuality
} from '../src/main/modules/comic/merge.mjs'
import { renameComicDirectories } from '../src/main/modules/comic/rename.mjs'
import {
  COMIC_STATE_PENDING_NAME,
  isComicSnapshotCurrent,
  scanComic,
  scanComicWorkspace
} from '../src/main/modules/comic/scan.mjs'

// sharp 生成真实 1x1 PNG：与生产端同一解码链路，避免手写 base64 图的兼容性差异
const TINY_PNG = await sharp({
  create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 255, b: 255 } }
})
  .png()
  .toBuffer()

const withTempDir = async (fn) => {
  const root = await mkdtemp(join(tmpdir(), 'msd-comic-test-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const page = { data: TINY_PNG, width: 1, height: 1, ext: 'png' }

/**
 * 构造「SOS 标记前夹带 16128 字节垃圾」的坏 JPEG（复刻用户报障
 * 「Corrupt JPEG data: 16128 extraneous bytes before marker 0xda」场景）。
 * 该图在 sharp 默认 failOn='warning' 下解码会直接抛错。
 */
const corruptJpeg = async () => {
  const clean = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 50, b: 50 } }
  })
    .jpeg()
    .toBuffer()
  const sosIdx = clean.indexOf(Buffer.from([0xff, 0xda]))
  return Buffer.concat([
    clean.subarray(0, sosIdx),
    Buffer.alloc(16128, 0x5a),
    clean.subarray(sosIdx)
  ])
}

test('漫画扫描跳过指向工作区外的符号链接目录', async () => {
  await withTempDir(async (root) => {
    const external = await mkdtemp(join(tmpdir(), 'msd-comic-external-'))
    try {
      await mkdir(join(root, '正常漫画', '第1话'), { recursive: true })
      await writeFile(join(root, '正常漫画', '第1话', '1.png'), TINY_PNG)
      await mkdir(join(external, '第1话'), { recursive: true })
      await writeFile(join(external, '第1话', 'outside.png'), TINY_PNG)
      await symlink(external, join(root, '外链漫画'))

      const result = await scanComicWorkspace(root)
      assert.deepEqual(
        result.comics.map((comic) => comic.name),
        ['正常漫画']
      )
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })
})

test('漫画扫描快照会检测嵌套目录新增页，过期时不可复用', async () => {
  await withTempDir(async (root) => {
    const comicDir = join(root, '快照漫画')
    await mkdir(join(comicDir, '第1话', '分镜'), { recursive: true })
    await writeFile(join(comicDir, '第1话', '分镜', '1.png'), TINY_PNG)
    const comic = await scanComic(root, '快照漫画')
    assert.equal(await isComicSnapshotCurrent(root, '快照漫画', comic.snapshot), true)

    await writeFile(join(comicDir, '第1话', '分镜', '2.png'), TINY_PNG)
    assert.equal(await isComicSnapshotCurrent(root, '快照漫画', comic.snapshot), false)
  })
})

test('EPUB：创建后有正确页数、章节导航，增量追加保持顺序', () => {
  const initial = createEpub({
    title: '测试漫画',
    chapters: [
      { name: '第1话', pages: [page, page] },
      { name: '第2话', pages: [page] }
    ]
  })
  assert.equal(countEpubPages(initial), 3)
  assert.deepEqual(listEpubNavItems(initial), ['第1话', '第2话'])

  const updated = appendEpub(initial, {
    title: '测试漫画',
    existingChapters: [
      { name: '第1话', pageCount: 2 },
      { name: '第2话', pageCount: 1 }
    ],
    newChapters: [{ name: '第3话', pages: [page, page] }]
  })
  assert.equal(countEpubPages(updated), 5)
  assert.deepEqual(listEpubNavItems(updated), ['第1话', '第2话', '第3话'])
})

test('PDF：创建与增量追加页数正确', async () => {
  const initial = await createPdf({ title: '测试漫画', pages: [page, page] })
  assert.equal((await PDFDocument.load(initial)).getPageCount(), 2)
  const updated = await appendPdf(initial, { pages: [page] })
  assert.equal((await PDFDocument.load(updated)).getPageCount(), 3)
})

test('自建流式 PDF：对象组装、超长页缩放与完整解析校验', async () => {
  const objects = buildNativePdfPageObjects({
    index: 2,
    width: 800,
    height: 1200,
    imageLength: 123
  })
  assert.equal(objects.pageId, 10)
  assert.match(objects.imageStart, /\/Filter \/DCTDecode/)
  const longPage = buildNativePdfPageObjects({
    index: 0,
    width: 800,
    height: 20000,
    imageLength: 123
  })
  assert.equal(longPage.pageWidth, 560)
  assert.equal(longPage.pageHeight, 14000)
  assert.match(longPage.page, /\/MediaBox \[0 0 560 14000\]/)
  assert.match(longPage.content, /560 0 0 14000 0 0 cm/)
  await withTempDir(async (root) => {
    const output = join(root, 'native.pdf')
    const jpeg = await sharp({
      create: { width: 1, height: 15000, channels: 3, background: { r: 255, g: 255, b: 255 } }
    })
      .jpeg()
      .toBuffer()
    async function* pages() {
      yield { data: jpeg, width: 1, height: 15000, ext: 'jpg' }
      yield { data: jpeg, width: 1, height: 15000, ext: 'jpg' }
    }
    const result = await createNativePdfFile({
      outputPath: output,
      title: '流式测试',
      pageCount: 2,
      pages: pages()
    })
    assert.equal(result.engine, 'stream-pdf')
    await verifyNativePdfFile(output, 2)
    const document = await PDFDocument.load(await readFile(output))
    assert.equal(document.getPageCount(), 2)
    assert.deepEqual(document.getPage(0).getSize(), { width: 1, height: 14000 })
  })
})

test('自建流式 PDF：写流中途报错会被接住并拒绝写入', async () => {
  await withTempDir(async (root) => {
    const output = join(root, 'failed.pdf')
    const jpeg = await sharp(TINY_PNG).jpeg().toBuffer()
    let writes = 0
    const createFailingStream = () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          writes += 1
          callback(writes === 3 ? new Error('模拟磁盘写入失败') : null)
        }
      })
    async function* pages() {
      yield { data: jpeg, width: 1, height: 1, ext: 'jpg' }
    }
    await assert.rejects(
      () =>
        createNativePdfFile({
          outputPath: output,
          title: '失败测试',
          pageCount: 1,
          pages: pages(),
          createWriteStream: createFailingStream
        }),
      /模拟磁盘写入失败/
    )
  })
})

test('PDF 原样模式：CMYK JPEG 回退 pdf-lib，避免按 DeviceRGB 直嵌', async () => {
  await withTempDir(async (root) => {
    const comicDir = join(root, 'CMYK 漫画')
    await mkdir(join(comicDir, '第1话'), { recursive: true })
    const source = join(comicDir, '第1话', '1.jpg')
    await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 40, g: 50, b: 60 } }
    })
      .toColorspace('cmyk')
      .jpeg()
      .toFile(source)
    assert.equal((await sharp(source).metadata()).space, 'cmyk')
    const result = await mergeOneComic(root, 'CMYK 漫画', {
      format: 'pdf',
      raw: true,
      pdfQuality: 'raw'
    })
    assert.equal(result.pdfEngine, 'pdf-lib')
    assert.match(result.pdfFallbackReason, /非 sRGB 三通道 JPEG/)
  })
})

test('PDF 质量归一化：high/text 降为 balanced，原样复选框优先', () => {
  assert.equal(resolvePdfQuality('balanced'), 'balanced')
  assert.equal(resolvePdfQuality('raw'), 'raw')
  assert.equal(resolvePdfQuality('high'), 'balanced')
  assert.equal(resolvePdfQuality('text'), 'balanced')
  assert.equal(resolvePdfQuality(undefined, true), 'raw')
  assert.equal(resolvePdfQuality('high', true), 'raw')
})

test('PDF 旧清单 high/text 自动全量重建为默认优化', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, 'PDF质量漫画')
    await mkdir(join(comic, '第1话'), { recursive: true })
    await writeFile(join(comic, '第1话', '1.png'), TINY_PNG)
    await mergeOneComic(root, 'PDF质量漫画', { format: 'pdf', pdfQuality: 'high' })
    const statePath = join(comic, '.comic-merge.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(state.pdfQuality, 'balanced')

    state.pdfQuality = 'text'
    await writeFile(statePath, JSON.stringify(state, null, 2))
    await mkdir(join(comic, '第2话'), { recursive: true })
    await writeFile(join(comic, '第2话', '1.png'), TINY_PNG)

    const result = await mergeOneComic(root, 'PDF质量漫画', { format: 'pdf' })
    assert.equal(result.mode, 'full')
    assert.equal(result.pdfQuality, 'balanced')
    const next = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(next.pdfQuality, 'balanced')
    assert.equal(next.chapters.length, 2)
  })
})

test('PDF 在原样与默认优化之间切换时要求全量重建', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, 'PDF质量漫画')
    await mkdir(join(comic, '第1话'), { recursive: true })
    await writeFile(join(comic, '第1话', '1.png'), TINY_PNG)
    await mergeOneComic(root, 'PDF质量漫画', { format: 'pdf' })

    await mkdir(join(comic, '第2话'), { recursive: true })
    await writeFile(join(comic, '第2话', '1.png'), TINY_PNG)
    await assert.rejects(
      () => mergeOneComic(root, 'PDF质量漫画', { format: 'pdf', raw: true }),
      /质量预设已变化/
    )
  })
})

test('PDF 文件校验会拒绝页数不符或损坏产物', async () => {
  await withTempDir(async (root) => {
    const output = join(root, 'book.pdf')
    await writeFile(output, await createPdf({ title: '测试漫画', pages: [page] }))
    await verifyPdfFile(output, 1)
    await assert.rejects(() => verifyPdfFile(output, 2), /页数校验失败/)
    await writeFile(output, 'broken')
    await assert.rejects(() => verifyPdfFile(output, 1))
  })
})

test('大漫画产物摘要以流式 SHA-256 计算', async () => {
  await withTempDir(async (root) => {
    const output = join(root, 'book.epub')
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 37, 0xab)
    await writeFile(output, bytes)
    assert.equal(await sha256File(output), createHash('sha256').update(bytes).digest('hex'))
  })
})

test('PDF 默认预处理应用 EXIF 方向、sRGB 和 4:2:0；透明图安全铺白', async () => {
  await withTempDir(async (root) => {
    const rotated = join(root, 'rotated.jpg')
    const transparent = join(root, 'transparent.png')
    await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 40, g: 50, b: 60 } }
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(rotated)
    await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } }
    })
      .png()
      .toFile(transparent)

    const optimized = await prepareComicPage(rotated, {
      format: 'pdf',
      raw: false,
      pdfQuality: 'balanced'
    })
    const optimizedMetadata = await sharp(optimized.data).metadata()
    assert.deepEqual([optimized.width, optimized.height], [20, 40])
    assert.equal(optimizedMetadata.space, 'srgb')
    assert.equal(optimizedMetadata.chromaSubsampling, '4:2:0')

    const flattened = await prepareComicPage(transparent, {
      format: 'pdf',
      raw: false,
      pdfQuality: 'balanced'
    })
    const flattenedMetadata = await sharp(flattened.data).metadata()
    const pixels = await sharp(flattened.data).raw().toBuffer()
    assert.equal(flattenedMetadata.hasAlpha, false)
    assert.deepEqual([...pixels.slice(0, 3)], [255, 255, 255])
  })
})

test('EPUB 流式创建与追加：大量页面不在内存中累积且可校验', async () => {
  await withTempDir(async (root) => {
    const images = join(root, 'images')
    const first = join(root, 'first.epub')
    const updated = join(root, 'updated.epub')
    await mkdir(images)
    const pages = []
    for (let index = 0; index < 1200; index += 1) {
      const path = join(images, `${index}.png`)
      await writeFile(path, TINY_PNG)
      pages.push({ path })
    }
    const prepare = async ({ path }) => ({
      sourcePath: path,
      width: 1,
      height: 1,
      ext: 'png',
      data: null
    })
    await createEpubFile({
      outputPath: first,
      title: '千页测试',
      chapters: [{ name: '第1话', pages: pages.slice(0, 1000) }],
      preparePage: prepare
    })
    await verifyEpubFile(first, 1000)
    await appendEpubFile({
      sourcePath: first,
      outputPath: updated,
      title: '千页测试',
      existingChapters: [{ name: '第1话', pageCount: 1000 }],
      newChapters: [{ name: '第2话', pages: pages.slice(1000) }],
      preparePage: prepare
    })
    await verifyEpubFile(updated, 1200)
    assert.ok((await stat(updated)).size > 0)
  })
})

test('漫画扫描：一级目录为漫画，章节自然排序，扁平图片为正篇', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '测试漫画')
    await mkdir(join(comic, '第10话'), { recursive: true })
    await mkdir(join(comic, '第2话'), { recursive: true })
    await writeFile(join(comic, 'cover.png'), TINY_PNG)
    await writeFile(join(comic, '第2话', '10.png'), TINY_PNG)
    await writeFile(join(comic, '第2话', '2.png'), TINY_PNG)
    await writeFile(join(comic, '第10话', '1.png'), TINY_PNG)
    await writeFile(join(comic, '.hidden.png'), TINY_PNG)

    const result = await scanComicWorkspace(root)
    assert.equal(result.comics.length, 1)
    const found = result.comics[0]
    assert.equal(found.imageCount, 4)
    assert.deepEqual(
      found.chapters.map((chapter) => chapter.relDir),
      ['', '第2话', '第10话']
    )
    assert.deepEqual(found.chapters[1].images, ['第2话/2.png', '第2话/10.png'])
  })
})

test('漫画扫描跳过可见封面，封面不参与追更章节识别', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '封面漫画')
    await mkdir(join(comic, '第1话'), { recursive: true })
    await writeFile(join(comic, '第1话', '1.png'), TINY_PNG)
    await writeFile(join(comic, '封面漫画-cover.jpg'), TINY_PNG)

    const found = (await scanComicWorkspace(root)).comics[0]
    assert.equal(found.imageCount, 1)
    assert.deepEqual(
      found.chapters.map((chapter) => chapter.images),
      [['第1话/1.png']]
    )
  })
})

test('漫画改名会同步重命名产物、封面与清单', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '旧漫画名')
    await mkdir(join(comic, '第1话'), { recursive: true })
    await writeFile(join(comic, '第1话', '1.png'), TINY_PNG)
    const taskCenter = createTaskCenter()
    await mergeComics(root, {
      relDirs: ['旧漫画名'],
      format: 'epub',
      taskCenter,
      taskId: 'comic-rename-merge',
      concurrency: 1
    })
    const renamed = await renameComicDirectories(
      root,
      [{ relDir: '旧漫画名', newName: '新漫画名' }],
      {
        taskCenter,
        taskId: 'comic-rename',
        concurrency: 1
      }
    )
    assert.equal(renamed.renamedCount, 1)
    await stat(join(root, '新漫画名', '新漫画名.epub'))
    await stat(join(root, '新漫画名', '新漫画名-cover.jpg'))
    const state = JSON.parse(await readFile(join(root, '新漫画名', '.comic-merge.json'), 'utf8'))
    assert.equal(state.outputName, '新漫画名.epub')
    assert.equal(state.coverName, '新漫画名-cover.jpg')
  })
})

test('漫画改名支持名称交换，且不留下临时目录', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, '漫画A', '第1话'), { recursive: true })
    await mkdir(join(root, '漫画B', '第1话'), { recursive: true })
    await writeFile(join(root, '漫画A', '第1话', 'a.png'), TINY_PNG)
    await writeFile(join(root, '漫画B', '第1话', 'b.png'), TINY_PNG)
    const report = await renameComicDirectories(
      root,
      [
        { relDir: '漫画A', newName: '漫画B' },
        { relDir: '漫画B', newName: '漫画A' }
      ],
      { taskCenter: createTaskCenter(), taskId: 'comic-rename-swap', concurrency: 2 }
    )
    assert.equal(report.failed.length, 0)
    assert.equal(await readFile(join(root, '漫画A', '第1话', 'b.png'), 'utf8'), TINY_PNG.toString())
    assert.equal(await readFile(join(root, '漫画B', '第1话', 'a.png'), 'utf8'), TINY_PNG.toString())
  })
})

test('漫画改名：目标被未参与改名的目录占用时前置拒绝，不进入暂存', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, '漫画1', '第1话'), { recursive: true })
    await mkdir(join(root, '漫画1_副本', '第1话'), { recursive: true })
    await writeFile(join(root, '漫画1', '第1话', '1.png'), TINY_PNG)
    await writeFile(join(root, '漫画1_副本', '第1话', '2.png'), TINY_PNG)

    // 模拟「正则去掉 _副本」场景：漫画1 未改动不参与改名，副本项必须前置拒绝而非暂存后失败
    const report = await renameComicDirectories(
      root,
      [{ relDir: '漫画1_副本', newName: '漫画1' }],
      { taskCenter: createTaskCenter(), taskId: 'comic-rename-occupied', concurrency: 1 }
    )
    assert.equal(report.renamedCount, 0)
    assert.equal(report.failed.length, 1)
    assert.equal(report.failed[0].target, '漫画1_副本')
    assert.match(report.failed[0].error, /已被未参与改名的漫画占用/)
    // 两个原目录都保持不动（未经历暂存/提交的破坏）
    assert.equal(await readFile(join(root, '漫画1', '第1话', '1.png'), 'utf8'), TINY_PNG.toString())
    assert.equal(
      await readFile(join(root, '漫画1_副本', '第1话', '2.png'), 'utf8'),
      TINY_PNG.toString()
    )
  })
})

test('漫画改名：目标名称重复只报一次错误，不重复进入暂存提交', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, '漫画A', '第1话'), { recursive: true })
    await mkdir(join(root, '漫画B', '第1话'), { recursive: true })
    await writeFile(join(root, '漫画A', '第1话', '1.png'), TINY_PNG)
    await writeFile(join(root, '漫画B', '第1话', '2.png'), TINY_PNG)

    const report = await renameComicDirectories(
      root,
      [
        { relDir: '漫画A', newName: '同名' },
        { relDir: '漫画B', newName: '同名' }
      ],
      { taskCenter: createTaskCenter(), taskId: 'comic-rename-dup', concurrency: 1 }
    )
    // 先到的那项成功，重复项只在前置校验报一次「目标名称重复」，不会在提交阶段再失败
    assert.equal(report.renamedCount, 1)
    assert.equal(report.failed.length, 1)
    assert.match(report.failed[0].error, /目标名称重复/)
    assert.deepEqual((await readdir(root)).sort(), ['同名', '漫画B'].sort())
  })
})

test('原样 EPUB 合并完成后立即释放源图句柄，Windows 可立刻改名和删除', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '句柄释放漫画')
    const chapter = join(comic, '第1话')
    await mkdir(chapter, { recursive: true })
    const source = join(chapter, '1.png')
    await writeFile(source, TINY_PNG)
    const taskCenter = createTaskCenter()

    const report = await mergeComics(root, {
      relDirs: ['句柄释放漫画'],
      format: 'epub',
      raw: true,
      taskCenter,
      taskId: 'comic-raw-handle-release',
      concurrency: 1
    })
    assert.equal(report.failed.length, 0)
    // Windows 上未关闭的 ReadStream 会让 rename/rm 报 EPERM；这里直接验证合并 Promise
    // resolve 即意味着源图流已 close，后续删源不可能把它扫描成“新增页”。
    const moved = join(chapter, '1-moved.png')
    await rename(source, moved)
    await rm(moved)

    const state = JSON.parse(await readFile(join(comic, '.comic-merge.json'), 'utf8'))
    assert.deepEqual(state.chapters[0].images, ['第1话/1.png'])
  })
})

test('漫画删源仅依据已提交清单，不删除合并后出现的新图片', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '删源快照漫画')
    const chapter = join(comic, '第1话')
    await mkdir(chapter, { recursive: true })
    await writeFile(join(chapter, '1.png'), TINY_PNG)
    const taskCenter = createTaskCenter()
    const merged = await mergeComics(root, {
      relDirs: ['删源快照漫画'],
      format: 'epub',
      taskCenter,
      taskId: 'comic-delete-snapshot-merge',
      concurrency: 1
    })
    assert.equal(merged.failed.length, 0)
    const newPage = join(chapter, '2.png')
    await writeFile(newPage, TINY_PNG)

    const deleted = await deleteComicSources(root, {
      relDirs: ['删源快照漫画'],
      taskCenter,
      taskId: 'comic-delete-snapshot-delete',
      concurrency: 1,
      deleteFn: async (target) => rm(target, { force: true })
    })
    assert.equal(deleted.deletedCount, 1)
    assert.equal(await readFile(newPage, 'utf8'), TINY_PNG.toString())
  })
})

test('漫画合并：删源后追更仍可增量追加', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '删源追更漫画')
    await mkdir(join(comic, '第1话'), { recursive: true })
    await writeFile(join(comic, '第1话', '1.png'), TINY_PNG)
    const taskCenter = createTaskCenter()

    const first = await mergeComics(root, {
      relDirs: ['删源追更漫画'],
      format: 'epub',
      taskCenter,
      taskId: 'comic-delete-first',
      concurrency: 1
    })
    assert.equal(first.failed.length, 0)
    const deleted = await deleteComicSources(root, {
      relDirs: ['删源追更漫画'],
      taskCenter,
      taskId: 'comic-delete-source',
      concurrency: 1,
      deleteFn: async (target) => rm(target, { force: true })
    })
    assert.equal(deleted.deletedCount, 1)

    await mkdir(join(comic, '第2话'), { recursive: true })
    await writeFile(join(comic, '第2话', '1.png'), TINY_PNG)
    const update = await mergeComics(root, {
      relDirs: ['删源追更漫画'],
      format: 'epub',
      taskCenter,
      taskId: 'comic-delete-update',
      concurrency: 1
    })
    assert.equal(update.failed.length, 0)
    assert.equal(update.merged[0].mode, 'update')
    assert.equal(countEpubPages(await readFile(join(comic, '删源追更漫画.epub'))), 2)
  })
})

test('漫画合并：首次全量 EPUB 后新增章节可增量追加并更新清单', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '追更漫画')
    await mkdir(join(comic, '第1话'), { recursive: true })
    await writeFile(join(comic, '第1话', '1.png'), TINY_PNG)
    const taskCenter = createTaskCenter()

    const first = await mergeComics(root, {
      relDirs: ['追更漫画'],
      format: 'epub',
      taskCenter,
      taskId: 'comic-first',
      concurrency: 1
    })
    assert.equal(first.failed.length, 0)
    assert.equal(first.merged[0].mode, 'full')
    assert.equal(countEpubPages(await readFile(join(comic, '追更漫画.epub'))), 1)

    await mkdir(join(comic, '第2话'), { recursive: true })
    await writeFile(join(comic, '第2话', '1.png'), TINY_PNG)
    const second = await mergeComics(root, {
      relDirs: ['追更漫画'],
      format: 'epub',
      taskCenter,
      taskId: 'comic-update',
      concurrency: 1
    })
    assert.equal(second.failed.length, 0)
    assert.equal(second.merged[0].mode, 'update')
    assert.equal(countEpubPages(await readFile(join(comic, '追更漫画.epub'))), 2)

    const state = JSON.parse(await readFile(join(comic, '.comic-merge.json'), 'utf8'))
    assert.equal(state.chapters.length, 2)
  })
})

test('漫画增量：产物提交后清单写入失败会由 marker 恢复', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '事务恢复漫画')
    await mkdir(join(comic, '第1话'), { recursive: true })
    await writeFile(join(comic, '第1话', '1.png'), TINY_PNG)
    const taskCenter = createTaskCenter()
    await mergeComics(root, {
      relDirs: ['事务恢复漫画'],
      format: 'epub',
      taskCenter,
      taskId: 'comic-transaction-first',
      concurrency: 1
    })
    await mkdir(join(comic, '第2话'), { recursive: true })
    await writeFile(join(comic, '第2话', '1.png'), TINY_PNG)
    await assert.rejects(
      () =>
        mergeOneComic(root, '事务恢复漫画', {
          format: 'epub',
          writeState: async () => {
            throw new Error('模拟清单写入失败')
          }
        }),
      /模拟清单写入失败/
    )
    await readFile(join(comic, COMIC_STATE_PENDING_NAME))
    const recovered = (await scanComicWorkspace(root)).comics[0]
    assert.equal(recovered.merged.chapters.length, 2)
    assert.equal(recovered.newChapters.length, 0)
    await assert.rejects(() => readFile(join(comic, COMIC_STATE_PENDING_NAME)))
  })
})

test('漫画轻量刷新仍递归统计嵌套章节页', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '嵌套章节')
    await mkdir(join(comic, '第1话', '分镜'), { recursive: true })
    await writeFile(join(comic, '第1话', '分镜', '1.png'), TINY_PNG)
    const scanned = await scanComicWorkspace(root, { light: true })
    assert.equal(scanned.comics[0].chapters[0].images.length, 1)
  })
})

test('漫画合并：坏 JPEG（SOS 前垃圾字节）优化模式自动修复，整本不失败', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '坏图修复漫画')
    const chapter = join(comic, '第1话')
    await mkdir(chapter, { recursive: true })
    await writeFile(join(chapter, '1.jpg'), await corruptJpeg())
    await writeFile(join(chapter, '2.png'), TINY_PNG)
    const taskCenter = createTaskCenter()

    const report = await mergeComics(root, {
      relDirs: ['坏图修复漫画'],
      format: 'epub',
      taskCenter,
      taskId: 'comic-repair-opt',
      concurrency: 1
    })
    assert.equal(report.failed.length, 0)
    assert.equal(report.merged[0].repairedPages, 1)
    const epubBytes = await readFile(join(comic, '坏图修复漫画.epub'))
    assert.equal(countEpubPages(epubBytes), 2)
    // 书内图片已是可正常解码的干净 JPEG（不再携带垃圾字节）
    const files = unzipSync(epubBytes)
    const image = Object.keys(files).find((name) => /^OEBPS\/images\/p\d+\.jpg$/.test(name))
    const meta = await sharp(files[image]).metadata()
    assert.equal(meta.width, 4)
  })
})

test('漫画合并：原样 EPUB 遇坏 JPEG 自动转码修复，坏图不原样入书', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '原样坏图修复')
    const chapter = join(comic, '第1话')
    await mkdir(chapter, { recursive: true })
    await writeFile(join(chapter, '1.jpg'), await corruptJpeg())
    const taskCenter = createTaskCenter()

    const report = await mergeComics(root, {
      relDirs: ['原样坏图修复'],
      format: 'epub',
      raw: true,
      taskCenter,
      taskId: 'comic-repair-raw-epub',
      concurrency: 1
    })
    assert.equal(report.failed.length, 0)
    assert.equal(report.merged[0].repairedPages, 1)
    const files = unzipSync(await readFile(join(comic, '原样坏图修复.epub')))
    const image = Object.keys(files).find((name) => /^OEBPS\/images\/p\d+\.jpg$/.test(name))
    const meta = await sharp(files[image]).metadata()
    assert.equal(meta.width, 4)
  })
})

test('漫画合并：原样 PDF 遇坏 JPEG 自动修复，PDF 页数正确', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '原样坏图PDF')
    const chapter = join(comic, '第1话')
    await mkdir(chapter, { recursive: true })
    await writeFile(join(chapter, '1.jpg'), await corruptJpeg())
    const taskCenter = createTaskCenter()

    const report = await mergeComics(root, {
      relDirs: ['原样坏图PDF'],
      format: 'pdf',
      raw: true,
      taskCenter,
      taskId: 'comic-repair-raw-pdf',
      concurrency: 1
    })
    assert.equal(report.failed.length, 0)
    assert.equal(report.merged[0].repairedPages, 1)
    const doc = await PDFDocument.load(await readFile(join(comic, '原样坏图PDF.pdf')))
    assert.equal(doc.getPageCount(), 1)
  })
})

test('漫画合并：仅 EOI 后多余字节的 jpg，原样模式不触发修复（保留源字节）', async () => {
  await withTempDir(async (root) => {
    const comic = join(root, '尾部垃圾保留')
    const chapter = join(comic, '第1话')
    await mkdir(chapter, { recursive: true })
    const clean = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } }
    })
      .jpeg()
      .toBuffer()
    const source = Buffer.concat([clean, Buffer.from('EXTRA-AFTER-EOI')])
    await writeFile(join(chapter, '1.jpg'), source)
    const taskCenter = createTaskCenter()

    const report = await mergeComics(root, {
      relDirs: ['尾部垃圾保留'],
      format: 'epub',
      raw: true,
      taskCenter,
      taskId: 'comic-trailing-raw',
      concurrency: 1
    })
    assert.equal(report.failed.length, 0)
    assert.equal(report.merged[0].repairedPages, 0)
    const files = unzipSync(await readFile(join(comic, '尾部垃圾保留.epub')))
    const image = Object.keys(files).find((name) => /^OEBPS\/images\/p\d+\.jpg$/.test(name))
    // 尾部垃圾解码器普遍宽容，保留源字节以维持原样模式「零重编码」语义
    assert.equal(Buffer.compare(files[image], source), 0)
  })
})

test('漫画合并：合并失败时将漫画目录移入「合并失败」文件夹，且扫描自动忽略该文件夹', async () => {
  await withTempDir(async (root) => {
    const successComic = join(root, '成功漫画')
    const failComic = join(root, '失败漫画')
    await mkdir(join(successComic, '第1话'), { recursive: true })
    await mkdir(join(failComic, '第1话'), { recursive: true })
    await writeFile(join(successComic, '第1话', '1.png'), TINY_PNG)
    // 写入一个无法解码的非图片坏文件作为 png，触发合并失败
    await writeFile(join(failComic, '第1话', '1.png'), Buffer.from('NOT_A_VALID_IMAGE_DATA'))

    const taskCenter = createTaskCenter()
    const report = await mergeComics(root, {
      relDirs: ['成功漫画', '失败漫画'],
      format: 'epub',
      taskCenter,
      taskId: 'comic-fail-move',
      concurrency: 2
    })

    assert.equal(report.merged.length, 1)
    assert.equal(report.merged[0].name, '成功漫画')
    assert.equal(report.failed.length, 1)
    assert.equal(report.failed[0].target, '失败漫画')
    assert.equal(report.failed[0].movedTo, join('合并失败', '失败漫画'))

    // 验证原路径已不存在，失败漫画已被移入「合并失败/失败漫画」
    const originalExists = await readdir(root)
    assert.ok(!originalExists.includes('失败漫画'))
    assert.ok(originalExists.includes('合并失败'))
    assert.ok(originalExists.includes('成功漫画'))

    const failedEntries = await readdir(join(root, '合并失败'))
    assert.deepEqual(failedEntries, ['失败漫画'])

    // 扫描工作区时，「合并失败」文件夹被排除，只扫描出「成功漫画」
    const scan = await scanComicWorkspace(root)
    assert.deepEqual(
      scan.comics.map((c) => c.name),
      ['成功漫画']
    )
  })
})
