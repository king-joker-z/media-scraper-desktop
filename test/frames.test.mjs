import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildCaptureArgs,
  buildFastCaptureArgs,
  buildFrameTimestamps,
  buildMultiCaptureArgs,
  captureFrame,
  captureFrames,
  detectSceneCuts,
  resolveFfmpegPath
} from '../src/main/core/frames.mjs'
import { pathExists } from '../src/main/core/fs-ops.mjs'

const execFileAsync = promisify(execFile)

test('buildFrameTimestamps keeps the first frame plus distributed candidates', () => {
  assert.deepEqual(buildFrameTimestamps(100_000), [0, 25, 50, 75, 90])
  assert.deepEqual(buildFrameTimestamps(10_000, 3), [0, 2.5, 5])
  assert.deepEqual(buildFrameTimestamps(0), [0, 0, 0, 0, 0])
})

test('buildCaptureArgs uses two-stage seek for long videos', () => {
  const short = buildCaptureArgs('v.mp4', 5, 'out.jpg')
  // 短视频：无预 seek，-ss 在 -i 之后精确截取
  assert.deepEqual(short.slice(0, 2), ['-v', 'error'])
  assert.ok(!short.slice(0, 4).includes('-ss'))
  const ssIndex = short.indexOf('-ss')
  assert.ok(short[ssIndex - 1] === 'v.mp4')
  assert.equal(short[ssIndex + 1], '5')

  const long = buildCaptureArgs('v.mp4', 500, 'out.jpg')
  // 长视频：先 -ss 490 再 -i，随后 -ss 10 精确
  assert.equal(long[2], '-ss')
  assert.equal(long[3], '490')
  const iIndex = long.indexOf('-i')
  assert.equal(long[iIndex + 2], '-ss')
  assert.equal(long[iIndex + 3], '10')
})

test('detectSceneCuts finds the color switch point', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-scene-'))
  try {
    const video = join(dir, 'scene.mp4')
    // 红 2s + 蓝 2s 拼接，2s 处必然发生场景突变
    await execFileAsync(resolveFfmpegPath(), [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=red:size=320x240:duration=2:rate=10[a];color=blue:size=320x240:duration=2:rate=10[b];[a][b]concat=n=2:v=1',
      '-pix_fmt',
      'yuv420p',
      '-y',
      video
    ])
    const cuts = await detectSceneCuts(video, { threshold: 0.3 })
    assert.ok(cuts.length >= 1, 'should detect at least one cut')
    assert.ok(
      cuts.some((t) => Math.abs(t - 2) < 0.6),
      `cut should be near 2s, got ${JSON.stringify(cuts)}`
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildFastCaptureArgs uses input-side seek only and skips non-video streams', () => {
  const args = buildFastCaptureArgs('v.mp4', 500, 'out.jpg', { width: 720, quality: 5 })
  // -ss 在 -i 之前（输入侧快速 seek），无第二段精确 seek
  const ssIndex = args.indexOf('-ss')
  const inputIndex = args.indexOf('-i')
  assert.ok(ssIndex >= 0 && ssIndex < inputIndex)
  assert.equal(args.filter((a) => a === '-ss').length, 1)
  assert.equal(args[ssIndex + 1], '500')
  assert.ok(args.includes('-an'))
  assert.ok(args.includes('-sn'))
  assert.ok(args.includes('-dn'))
  assert.ok(args.includes('scale=w=min(720\\,iw):h=-2'))
  assert.equal(args[args.indexOf('-q:v') + 1], '5')
})

test('captureFrame extracts real jpegs via both seek paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-frames-'))
  try {
    const video = join(dir, 'sample.mp4')
    // 用 ffmpeg lavfi 生成 12 秒测试视频（testsrc 生成很快）
    await execFileAsync(resolveFfmpegPath(), [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=12:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      '-y',
      video
    ])
    assert.equal(await pathExists(video), true)

    // 短 seek 路径（<=10s，-ss 在 -i 后）
    const frame = await captureFrame(video, 1, join(dir, 'frame.jpg'))
    const bytes = await readFile(frame)
    assert.equal(bytes[0], 0xff)
    assert.equal(bytes[1], 0xd8)

    // 长 seek 路径（>10s，两段式 seek）
    const frame2 = await captureFrame(video, 11, join(dir, 'frame2.jpg'))
    assert.equal(await pathExists(frame2), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildMultiCaptureArgs emits one -ss/-i pair per job and per-output maps', () => {
  const args = buildMultiCaptureArgs('/v/x.mp4', [
    { seconds: 1, target: '/o/a.jpg' },
    { seconds: 3, target: '/o/b.jpg' },
    { seconds: 5, target: '/o/c.jpg' }
  ])
  // 三个输入：每个一组「-ss <t> -i <video>」
  const inputCount = args.filter((a) => a === '-i').length
  assert.equal(inputCount, 3)
  // 三个输出：每个一组「-map <i>:v ... -y <target>」
  assert.equal(args.filter((a) => a === '-map').length, 3)
  assert.equal(args.filter((a) => a === '/o/a.jpg').length, 1)
  assert.equal(args.filter((a) => a === '/o/b.jpg').length, 1)
  assert.equal(args.filter((a) => a === '/o/c.jpg').length, 1)
  // execFile 在 Windows 不经 shell，滤镜表达式不能依赖 shell 去除单引号。
  assert.ok(args.includes('scale=w=min(1920\\,iw):h=-2'))
  // 顺序：先全部输入，再全部输出映射
  assert.equal(args.indexOf('-i') < args.indexOf('-map'), true)
})

test('captureFrames extracts multiple frames in one process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-frames-multi-'))
  try {
    const video = join(dir, 'sample.mp4')
    await execFileAsync(resolveFfmpegPath(), [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=12:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      '-y',
      video
    ])
    const jobs = [
      { seconds: 1, target: join(dir, 'c1.jpg') },
      { seconds: 5, target: join(dir, 'c2.jpg') },
      { seconds: 11, target: join(dir, 'c3.jpg') }
    ]
    const frames = await captureFrames(video, jobs)
    assert.equal(frames.length, 3)
    for (const f of frames) {
      const bytes = await readFile(f)
      assert.equal(bytes[0], 0xff) // JPEG SOI
      assert.equal(bytes[1], 0xd8)
    }
    // 越过末尾的时点不产生帧 → 被容忍剔除而非报错
    const partial = await captureFrames(video, [
      { seconds: 1, target: join(dir, 'p1.jpg') },
      { seconds: 999, target: join(dir, 'p2.jpg') }
    ])
    assert.equal(partial.length, 1)
    assert.equal(partial[0], join(dir, 'p1.jpg'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
