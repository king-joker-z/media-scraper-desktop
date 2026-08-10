import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
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
import { appendPdf, createPdf } from '../src/main/modules/comic/pdf.mjs'
import { deleteComicSources, mergeComics } from '../src/main/modules/comic/merge.mjs'
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
