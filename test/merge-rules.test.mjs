import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildConcatCopyArgs,
  buildConcatList,
  buildTranscodeArgs,
  checkCompatibility,
  estimateOutputBytes,
  isMergeOutputName,
  mergeOutputName,
  verifyMergeOutput
} from '../src/shared/merge-rules.mjs'

const media = (overrides = {}) => ({
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationMs: 10_000,
  sizeBytes: 1_000_000,
  width: 1920,
  height: 1080,
  orientation: 'landscape',
  videoCodec: 'h264',
  audioCodec: 'aac',
  fps: 30,
  pixFmt: 'yuv420p',
  sampleRate: 44100,
  channels: 2,
  ...overrides
})
const item = (name, mediaOverrides) => ({ name, media: media(mediaOverrides) })

test('checkCompatibility passes identical items and rejects mismatches', () => {
  assert.equal(checkCompatibility([item('a'), item('b')]).compatible, true)
  assert.equal(checkCompatibility([item('a')]).compatible, true)

  const result = checkCompatibility([
    item('a'),
    item('b', { videoCodec: 'hevc' }),
    item('c', { width: 1280, height: 720 })
  ])
  assert.equal(result.compatible, false)
  assert.ok(result.reasons.some((r) => r.includes('视频编码')))
  assert.ok(result.reasons.some((r) => r.includes('分辨率')))
  assert.equal(result.target.width, 1920)
  assert.equal(result.target.pixFmt, 'yuv420p')
})

test('checkCompatibility tolerates tiny fps differences', () => {
  const result = checkCompatibility([item('a', { fps: 29.97 }), item('b', { fps: 30 })])
  assert.equal(result.compatible, true)
})

test('estimateOutputBytes sums for copy and estimates for transcode', () => {
  const items = [item('a'), item('b')]
  assert.equal(estimateOutputBytes(items, true), 2_000_000)
  const transcoded = estimateOutputBytes(items, false)
  assert.ok(transcoded > 0)
})

test('mergeOutputName follows the frozen naming', () => {
  assert.equal(mergeOutputName('合集', 'all'), '合集-merged.mp4')
  assert.equal(mergeOutputName('合集', 'landscape'), '合集-landscape-merged.mp4')
  assert.equal(mergeOutputName('合集', 'portrait'), '合集-portrait-merged.mp4')
})

test('isMergeOutputName detects our own merge outputs', () => {
  assert.equal(isMergeOutputName('合集-merged.mp4'), true)
  assert.equal(isMergeOutputName('合集-landscape-merged.mp4'), true)
  assert.equal(isMergeOutputName('合集-custom-merged.mp4'), true)
  assert.equal(isMergeOutputName('合集-merged (1).mp4'), true)
  assert.equal(isMergeOutputName('正常视频.mp4'), false)
  assert.equal(isMergeOutputName('merged.mkv'), false)
})

test('buildConcatList escapes single quotes', () => {
  const list = buildConcatList(['/a/b.mp4', "/a/c'd.mp4"])
  assert.ok(list.includes("file '/a/b.mp4'"))
  assert.ok(list.includes("file '/a/c'\\''d.mp4'"))
})

test('buildConcatList converts Windows backslashes to forward slashes', () => {
  // ffmpeg concat demuxer 把 \ 视为转义符，Windows 路径必须转正斜杠
  const list = buildConcatList(['C:\\ws\\sub\\a.mp4', 'D:\\media\\b.mp4'])
  assert.ok(list.includes("file 'C:/ws/sub/a.mp4'"))
  assert.ok(list.includes("file 'D:/media/b.mp4'"))
  assert.ok(!list.includes('\\\\'))
})

test('buildTranscodeArgs targets unified params', () => {
  const args = buildTranscodeArgs(
    'in.mkv',
    { width: 1920, height: 1080, fps: 30, pixFmt: 'yuv420p' },
    'out.ts'
  )
  assert.ok(args.includes('libx264'))
  assert.ok(args.some((a) => a.startsWith('scale=1920:1080')))
  assert.ok(args.includes('aac'))
})

test('verifyMergeOutput validates duration and streams', () => {
  const items = [item('a'), item('b')]
  assert.equal(verifyMergeOutput(media({ durationMs: 20_000 }), items).ok, true)
  assert.equal(verifyMergeOutput(media({ durationMs: 30_000 }), items).ok, false) // 偏差过大
  assert.equal(verifyMergeOutput(media({ durationMs: 20_000, audioCodec: null }), items).ok, false) // 丢音轨
  assert.equal(verifyMergeOutput(media({ durationMs: 20_000, videoCodec: null }), items).ok, false)
  assert.equal(verifyMergeOutput(null, items).ok, false)
})

test('buildConcatCopyArgs uses stream copy', () => {
  const args = buildConcatCopyArgs('list.txt', 'out.mp4')
  assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'copy'])
})
