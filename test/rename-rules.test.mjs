import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRegexRules,
  buildSequenceStems,
  compareTitles,
  padSeq,
  sortVideos,
  validateStems
} from '../src/shared/rename-rules.mjs'

test('padSeq pads with zeros and respects digits', () => {
  assert.equal(padSeq(1, 2), '01')
  assert.equal(padSeq(12, 3), '012')
  assert.equal(padSeq(123, 2), '123')
})

test('compareTitles is numeric-aware', () => {
  assert.ok(compareTitles('视频 2', '视频 10') < 0)
  assert.ok(compareTitles('a', 'b') < 0)
})

test('sortVideos by title and size with order', () => {
  const videos = [
    { name: '视频 10.mp4', size: 5 },
    { name: '视频 2.mp4', size: 9 },
    { name: '视频 1.mp4', size: 1 }
  ]
  assert.deepEqual(
    sortVideos(videos, 'title', 'asc').map((v) => v.name),
    ['视频 1.mp4', '视频 2.mp4', '视频 10.mp4']
  )
  assert.deepEqual(
    sortVideos(videos, 'size', 'desc').map((v) => v.name),
    ['视频 2.mp4', '视频 10.mp4', '视频 1.mp4']
  )
})

test('buildSequenceStems generates padded serial with separator', () => {
  const videos = [
    { name: 'b.mp4', size: 2, relativePath: 'b.mp4' },
    { name: 'a.mp4', size: 1, relativePath: 'a.mp4' }
  ]
  const pairs = buildSequenceStems(videos, {
    sortBy: 'title',
    order: 'asc',
    digits: 2,
    separator: '.'
  })
  assert.deepEqual(pairs, [
    { videoRel: 'a.mp4', newStem: '01.a' },
    { videoRel: 'b.mp4', newStem: '02.b' }
  ])
})

test('applyRegexRules cleans noise and tolerates invalid patterns', () => {
  const rules = [
    { pattern: '@[^\\s@]+$', replacement: '', flags: 'g' },
    { pattern: '【[^】]*】', replacement: '', flags: 'g' },
    { pattern: '([invalid', replacement: '', flags: 'g' } // 非法正则跳过
  ]
  assert.equal(applyRegexRules('abc@111', rules), 'abc')
  assert.equal(applyRegexRules('【广告】电影  名', rules), '电影 名')
})

test('validateStems catches illegal, empty, long and duplicate names', () => {
  const errors = validateStems([
    { videoRel: 'a.mp4', newStem: 'ok' },
    { videoRel: 'b.mp4', newStem: 'a/b' },
    { videoRel: 'c.mp4', newStem: '  ' },
    { videoRel: 'd.mp4', newStem: 'x'.repeat(201) },
    { videoRel: 'e.mp4', newStem: 'OK' }, // 与 a.mp4 大小写冲突
    { videoRel: 'f.mp4', newStem: 'fine' }
  ])
  assert.equal(errors['a.mp4'], undefined)
  assert.ok(errors['b.mp4'].includes('非法字符'))
  assert.ok(errors['c.mp4'].includes('为空'))
  assert.ok(errors['d.mp4'].includes('超长'))
  assert.ok(errors['e.mp4'].includes('重名'))
  assert.equal(errors['f.mp4'], undefined)
})
