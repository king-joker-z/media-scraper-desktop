import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearProbeCache,
  parseFrameRate,
  parseProbeJson,
  probeMediaCached
} from '../src/main/core/probe.mjs'

test('parseFrameRate handles fractional, integer and missing rates', () => {
  assert.ok(Math.abs(parseFrameRate('30000/1001') - 29.97) < 0.01)
  assert.equal(parseFrameRate('25/1'), 25)
  assert.equal(parseFrameRate('60'), 60)
  assert.equal(parseFrameRate(undefined), 0)
  assert.equal(parseFrameRate('0/0'), 0)
})

test('parseProbeJson normalizes a typical ffprobe output', () => {
  const info = parseProbeJson({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.345', size: '1048576' },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        r_frame_rate: '30000/1001'
      },
      { codec_type: 'audio', codec_name: 'aac' }
    ]
  })
  assert.equal(info.container, 'mov,mp4,m4a,3gp,3g2,mj2')
  assert.equal(info.durationMs, 12345)
  assert.equal(info.sizeBytes, 1048576)
  assert.equal(info.width, 1920)
  assert.equal(info.height, 1080)
  assert.equal(info.orientation, 'landscape')
  assert.equal(info.videoCodec, 'h264')
  assert.equal(info.audioCodec, 'aac')
  assert.ok(Math.abs(info.fps - 29.97) < 0.01)
})

test('parseProbeJson swaps width/height for 90-degree rotated videos', () => {
  const info = parseProbeJson({
    format: { format_name: 'mov', duration: '5', size: '100' },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'hevc',
        width: 1920,
        height: 1080,
        r_frame_rate: '30/1',
        tags: { rotate: '90' }
      }
    ]
  })
  assert.equal(info.width, 1080)
  assert.equal(info.height, 1920)
  assert.equal(info.orientation, 'portrait')
  assert.equal(info.audioCodec, null)
})

test('probeMediaCached caches by path+mtime+size and refreshes on change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-probe-'))
  try {
    const file = join(dir, 'v.mp4')
    await writeFile(file, 'v1')
    let calls = 0
    const fakeProbe = async () => {
      calls += 1
      return { marker: calls }
    }
    clearProbeCache()
    const first = await probeMediaCached(file, 'ffprobe', fakeProbe)
    const second = await probeMediaCached(file, 'ffprobe', fakeProbe)
    assert.equal(calls, 1) // 第二次命中缓存
    assert.equal(second.marker, first.marker)
    // 修改内容（大小变化）→ 缓存失效
    await writeFile(file, 'v1-longer')
    // mtime 可能同秒，强制设置一个不同的 mtime
    await utimes(file, new Date(), new Date(Date.now() + 5000))
    await probeMediaCached(file, 'ffprobe', fakeProbe)
    assert.equal(calls, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseProbeJson tolerates missing streams and format fields', () => {
  const info = parseProbeJson({})
  assert.equal(info.container, '')
  assert.equal(info.durationMs, 0)
  assert.equal(info.videoCodec, null)
  // 无尺寸时宽>=高，归为横屏
  assert.equal(info.orientation, 'landscape')
})
