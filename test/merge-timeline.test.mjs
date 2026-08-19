import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTimelineSegments,
  outputSpecLabel,
  timelineDurationMs
} from '../src/renderer/src/components/merge-timeline.ts'

const item = (name, durationMs, overrides = {}) => ({
  name,
  relativePath: `${name}.mp4`,
  posterPath: null,
  media:
    durationMs === null
      ? null
      : {
          durationMs,
          width: 1920,
          height: 1080,
          orientation: 'landscape',
          videoCodec: 'h264',
          audioCodec: 'aac',
          fps: 30,
          sizeBytes: 1_000_000,
          ...overrides
        }
})

test('时间线按参与片段累加起止时间，排除项不占用主轨道比例', () => {
  const items = [
    item('开场', 10_000),
    item('排除的长片段', 3 * 60 * 60 * 1000),
    item('结尾', 20_000)
  ]
  const excluded = new Set(['排除的长片段.mp4'])

  const segments = buildTimelineSegments(items, excluded)

  assert.deepEqual(
    segments.map(({ startMs, endMs, included, widthWeight }) => ({
      startMs,
      endMs,
      included,
      widthWeight
    })),
    [
      { startMs: 0, endMs: 10_000, included: true, widthWeight: 10 },
      { startMs: 10_000, endMs: 10_000, included: false, widthWeight: 0 },
      { startMs: 10_000, endMs: 30_000, included: true, widthWeight: 20 }
    ]
  )
  assert.equal(timelineDurationMs(items, excluded), 30_000)
})

test('重新排序后按新顺序重建时间线，0 时长和无媒体信息不会增加总时长', () => {
  const items = [
    item('第三段', 3_000),
    item('零时长', 0),
    item('无媒体信息', null),
    item('第一段', 1_000)
  ]
  const segments = buildTimelineSegments(items, new Set())

  assert.deepEqual(
    segments.map((segment) => [segment.item.name, segment.startMs, segment.endMs]),
    [
      ['第三段', 0, 3_000],
      ['零时长', 3_000, 3_000],
      ['无媒体信息', 3_000, 3_000],
      ['第一段', 3_000, 4_000]
    ]
  )
  assert.equal(timelineDurationMs(items, new Set()), 4_000)
})

test('2、20、200 个片段的总时长和参与项合计一致', () => {
  for (const count of [2, 20, 200]) {
    const items = Array.from({ length: count }, (_, index) =>
      item(`片段${index + 1}`, (index + 1) * 1_000)
    )
    const excluded = new Set(
      items.filter((_, index) => index % 7 === 0).map((current) => current.relativePath)
    )
    const expected = items.reduce(
      (total, current) =>
        total + (excluded.has(current.relativePath) ? 0 : current.media.durationMs),
      0
    )

    const segments = buildTimelineSegments(items, excluded)
    assert.equal(timelineDurationMs(items, excluded), expected)
    assert.equal(segments.filter((segment) => segment.included).at(-1)?.endMs, expected)
    assert.equal(
      segments.filter((segment) => !segment.included).every((segment) => segment.widthWeight === 0),
      true
    )
  }
})

test('输出规格文案覆盖直拼、转码和无法确定规格', () => {
  assert.equal(
    outputSpecLabel({ compatible: true, reasons: [], target: null }),
    '兼容直拼，无重编码'
  )
  assert.equal(
    outputSpecLabel({ compatible: false, reasons: [], target: null }),
    '无法确定输出规格'
  )
  assert.equal(
    outputSpecLabel({
      compatible: false,
      reasons: ['分辨率不一致'],
      target: { width: 1920, height: 1080, fps: 29.97, pixFmt: 'yuv420p' }
    }),
    '1920×1080 · 30 fps · yuv420p'
  )
})
