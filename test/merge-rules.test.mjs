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
  selectQualityTarget,
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

test('quality target uses the highest-resolution source as a paired resolution/FPS target', () => {
  const target = selectQualityTarget([
    media({ width: 854, height: 480, fps: 24 }),
    media({ width: 3840, height: 2160, fps: 60 }),
    media({ width: 1920, height: 1080, fps: 30 })
  ])
  assert.deepEqual(target, { width: 3840, height: 2160, fps: 60, pixFmt: 'yuv420p' })

  const compatibility = checkCompatibility([
    item('低清在前', { width: 854, height: 480, fps: 24 }),
    item('4K在后', { width: 3840, height: 2160, fps: 60 })
  ])
  assert.deepEqual(compatibility.target, { width: 3840, height: 2160, fps: 60, pixFmt: 'yuv420p' })

  const mixedFps = selectQualityTarget([
    media({ width: 3840, height: 2160, fps: 24 }),
    media({ width: 1920, height: 1080, fps: 60 })
  ])
  assert.deepEqual(mixedFps, { width: 3840, height: 2160, fps: 24, pixFmt: 'yuv420p' })
})

test('quality target prefers a landscape canvas when horizontal and vertical clips are mixed', () => {
  const target = selectQualityTarget([
    media({ width: 1080, height: 1920, fps: 60 }),
    media({ width: 1920, height: 1080, fps: 30 })
  ])
  assert.deepEqual(target, { width: 1920, height: 1080, fps: 30, pixFmt: 'yuv420p' })

  const args = buildTranscodeArgs('vertical.mp4', target, 'out.mp4')
  assert.ok(
    args.includes(
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1'
    )
  )
})

test('quality target forces yuv420p for H.264 CPU and NVENC compatibility', () => {
  const target = selectQualityTarget([
    media({ pixFmt: 'yuv420p10le' }),
    media({ pixFmt: 'yuv420p10le' })
  ])
  assert.equal(target.pixFmt, 'yuv420p')
})

test('checkCompatibility rejects any item whose media information is unavailable', () => {
  const result = checkCompatibility([item('正常'), { name: '无法读取', media: null }])
  assert.equal(result.compatible, false)
  assert.equal(result.target.width, 1920)
  assert.match(result.reasons[0], /媒体信息读取失败/)
})

test('buildTranscodeArgs creates a silent AAC track for a no-audio input', () => {
  const args = buildTranscodeArgs(
    'silent.mp4',
    { width: 1920, height: 1080, fps: 30, pixFmt: 'yuv420p' },
    'out.mp4',
    { hasAudio: false }
  )
  assert.ok(args.includes('anullsrc=r=44100:cl=stereo'))
  assert.ok(args.includes('1:a:0'))
  assert.ok(args.includes('-shortest'))
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

test('buildTranscodeArgs uses high-quality NVENC settings when requested', () => {
  const args = buildTranscodeArgs(
    'in.mkv',
    { width: 3840, height: 2160, fps: 60, pixFmt: 'yuv420p' },
    'out.mp4',
    { encoder: 'nvenc' }
  )
  assert.ok(args.includes('h264_nvenc'))
  assert.deepEqual(args.slice(args.indexOf('-preset'), args.indexOf('-preset') + 2), [
    '-preset',
    'p5'
  ])
  assert.deepEqual(args.slice(args.indexOf('-cq'), args.indexOf('-cq') + 2), ['-cq', '18'])
  assert.ok(args.some((arg) => arg.startsWith('scale=3840:2160')))
})

test('verifyMergeOutput validates duration and streams', () => {
  const items = [item('a'), item('b')]
  assert.equal(verifyMergeOutput(media({ durationMs: 20_000 }), items).ok, true)
  assert.equal(verifyMergeOutput(media({ durationMs: 30_000 }), items).ok, false) // 偏差过大
  const manyItems = Array.from({ length: 106 }, (_, index) => item(`片段 ${index + 1}`))
  // 每段边界 50ms 的时间基量化误差可累计；106 段的 4.4s 偏差是正常输出。
  assert.equal(verifyMergeOutput(media({ durationMs: 1_064_400 }), manyItems).ok, true)
  assert.equal(verifyMergeOutput(media({ durationMs: 1_070_000 }), manyItems).ok, false)

  assert.equal(verifyMergeOutput(media({ durationMs: 20_000, audioCodec: null }), items).ok, false) // 丢音轨
  assert.equal(verifyMergeOutput(media({ durationMs: 20_000, videoCodec: null }), items).ok, false)
  assert.equal(verifyMergeOutput(null, items).ok, false)
  const silentItems = [item('无声 A', { audioCodec: null }), item('无声 B', { audioCodec: null })]
  assert.match(
    verifyMergeOutput(media({ durationMs: 20_000, audioCodec: null }), silentItems).note,
    /源片段均无音轨/
  )
})

test('buildConcatCopyArgs uses stream copy', () => {
  const args = buildConcatCopyArgs('list.txt', 'out.mp4')
  assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'copy'])
})
