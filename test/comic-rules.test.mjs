import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chapterDisplayName,
  comicOutputName,
  compareComicNames,
  diffComicChapters,
  isComicImage,
  sortComicChapters
} from '../src/shared/comic-rules.mjs'

test('漫画图片格式识别与输出命名', () => {
  assert.equal(isComicImage('p1.jpg'), true)
  assert.equal(isComicImage('p2.PNG'), true)
  assert.equal(isComicImage('p3.webp'), true)
  assert.equal(isComicImage('p4.avif'), true)
  assert.equal(isComicImage('video.mp4'), false)
  assert.equal(comicOutputName('进击的巨人', 'epub'), '进击的巨人.epub')
})

test('漫画章节/图片按自然顺序排序，扁平正篇排首位', () => {
  assert.deepEqual(['10.jpg', '2.jpg', '1.jpg'].sort(compareComicNames), [
    '1.jpg',
    '2.jpg',
    '10.jpg'
  ])
  const chapters = sortComicChapters([
    { name: '第10话', relDir: '第10话' },
    { name: '', relDir: '' },
    { name: '第2话', relDir: '第2话' }
  ])
  assert.deepEqual(
    chapters.map((chapter) => chapter.relDir),
    ['', '第2话', '第10话']
  )
  assert.equal(chapterDisplayName(chapters[0]), '正篇')
})

test('漫画更新检测：区分新增章节、章节内容变化与已删源图片', () => {
  const merged = {
    chapters: [
      { name: '第1话', relDir: '第1话', images: ['第1话/1.jpg', '第1话/2.jpg'] },
      { name: '第2话', relDir: '第2话', images: ['第2话/1.jpg'] }
    ]
  }
  const current = [
    { name: '第1话', relDir: '第1话', images: ['第1话/1.jpg', '第1话/2.jpg'] },
    { name: '第2话', relDir: '第2话', images: ['第2话/1.jpg', '第2话/2.jpg'] },
    { name: '第3话', relDir: '第3话', images: ['第3话/1.jpg'] }
  ]
  const diff = diffComicChapters(current, merged)
  assert.deepEqual(
    diff.newChapters.map((chapter) => chapter.relDir),
    ['第3话']
  )
  assert.deepEqual(diff.changedChapters, ['第2话'])

  // 已删除源图片的历史章节不会误报「内容变化」，新章仍可继续增量追加
  const deletedSources = diffComicChapters(
    [{ name: '第3话', relDir: '第3话', images: ['第3话/1.jpg'] }],
    merged
  )
  assert.deepEqual(
    deletedSources.newChapters.map((chapter) => chapter.relDir),
    ['第3话']
  )
  assert.deepEqual(deletedSources.changedChapters, [])
})

test('漫画更新检测：图片顺序变化需全量重建', () => {
  const diff = diffComicChapters([{ name: '', relDir: '', images: ['b.jpg', 'a.jpg'] }], {
    chapters: [{ name: '', relDir: '', images: ['a.jpg', 'b.jpg'] }]
  })
  assert.deepEqual(diff.changedChapters, ['正篇'])
})
