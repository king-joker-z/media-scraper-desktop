import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeRenameRelationships,
  buildRenameComparisonRows,
  matchesRenameFilter
} from '../src/renderer/src/components/rename-comparison.ts'

const source = (relativePath, name = relativePath) => ({
  relativePath,
  name,
  posterRelativePath: null,
  posterPath: null,
  size: 1
})

const pair = (videoRel, newStem, newExt) => ({ videoRel, posterRel: null, newStem, newExt })

test('对照数据复用共享校验并标记手动覆写与扩展名风险', () => {
  const rows = buildRenameComparisonRows({
    sources: [source('a.mkv'), source('b.mp4')],
    computedPairs: [pair('a.mkv', '节目'), pair('b.mp4', '节目')],
    pairs: [pair('a.mkv', '节目', '.mp4'), pair('b.mp4', '节目')],
    edits: { 'b.mp4': '节目' },
    mode: 'ext',
    extensionRisks: new Set(['a.mkv'])
  })

  assert.equal(rows[0].targetName, '节目.mp4')
  assert.equal(rows[0].risk, 'extension')
  assert.equal(rows[0].error, undefined)
  assert.equal(rows[1].manual, true)
  assert.equal(rows[1].risk, 'conflict')
  assert.ok(rows[1].error?.includes('同一目标'))
})

test('扩展名风险在没有重名时保留为独立风险类型', () => {
  const [row] = buildRenameComparisonRows({
    sources: [source('a.mkv')],
    computedPairs: [pair('a.mkv', '节目')],
    pairs: [pair('a.mkv', '节目', '.mp4')],
    edits: {},
    mode: 'ext',
    extensionRisks: new Set(['a.mkv'])
  })
  assert.equal(row.risk, 'extension')
})

test('对照模型按完整目录和扩展名判断批内目标冲突', () => {
  const rows = buildRenameComparisonRows({
    sources: [source('甲/A.mkv'), source('乙/B.mp4')],
    computedPairs: [pair('甲/A.mkv', '节目', '.mp4'), pair('乙/B.mp4', '节目')],
    pairs: [pair('甲/A.mkv', '节目', '.mp4'), pair('乙/B.mp4', '节目')],
    edits: {},
    mode: 'ext'
  })
  assert.equal(
    rows.every((row) => row.risk !== 'conflict'),
    true
  )
})

test('关系分析识别交换、循环和多项目标冲突，但不改变执行计划', () => {
  const swapRows = buildRenameComparisonRows({
    sources: [source('A.mp4'), source('B.mp4')],
    computedPairs: [pair('A.mp4', 'B'), pair('B.mp4', 'A')],
    pairs: [pair('A.mp4', 'B'), pair('B.mp4', 'A')],
    edits: {},
    mode: 'seq'
  })
  const swap = analyzeRenameRelationships(swapRows)
  assert.equal(swap[0].kind, 'swap')
  assert.equal(swap[0].members.length, 2)

  const duplicates = analyzeRenameRelationships(
    buildRenameComparisonRows({
      sources: [source('a.mp4'), source('b.mp4')],
      computedPairs: [pair('a.mp4', '同名'), pair('b.mp4', '同名')],
      pairs: [pair('a.mp4', '同名'), pair('b.mp4', '同名')],
      edits: {},
      mode: 'seq'
    })
  )
  assert.equal(
    duplicates.some((item) => item.kind === 'duplicate'),
    true
  )
})

test('筛选器按变更、风险、手动和 AI 来源过滤', () => {
  const [changed] = buildRenameComparisonRows({
    sources: [source('a.mp4')],
    computedPairs: [pair('a.mp4', '新名称')],
    pairs: [pair('a.mp4', '新名称')],
    edits: { 'a.mp4': '新名称' },
    mode: 'ai'
  })
  assert.equal(matchesRenameFilter(changed, 'changed'), true)
  assert.equal(matchesRenameFilter(changed, 'manual'), true)
  assert.equal(matchesRenameFilter(changed, 'ai'), true)
  assert.equal(matchesRenameFilter(changed, 'unchanged'), false)
})
