import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { unzipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { createTaskCenter } from '../src/main/core/task-center.mjs'
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
import { deleteComicSources, mergeComics } from '../src/main/modules/comic/merge.mjs'
import { renameComicDirectories } from '../src/main/modules/comic/rename.mjs'
import { scanComicWorkspace } from '../src/main/modules/comic/scan.mjs'

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
