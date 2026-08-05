import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFrameRate, parseProbeJson } from '../src/main/core/probe.mjs'

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

test('parseProbeJson tolerates missing streams and format fields', () => {
  const info = parseProbeJson({})
  assert.equal(info.container, '')
  assert.equal(info.durationMs, 0)
  assert.equal(info.videoCodec, null)
  // 无尺寸时宽>=高，归为横屏
  assert.equal(info.orientation, 'landscape')
})
