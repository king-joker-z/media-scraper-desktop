import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildCaptureArgs,
  buildFrameTimestamps,
  captureFrame,
  resolveFfmpegPath
} from '../src/main/core/frames.mjs'
import { pathExists } from '../src/main/core/fs-ops.mjs'

const execFileAsync = promisify(execFile)

test('buildFrameTimestamps returns 10/30/50/70/90% points in seconds', () => {
  assert.deepEqual(buildFrameTimestamps(100_000), [10, 30, 50, 70, 90])
  assert.deepEqual(buildFrameTimestamps(10_000, 3), [1, 3, 5])
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
