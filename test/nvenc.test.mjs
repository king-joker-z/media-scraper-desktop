import test from 'node:test'
import assert from 'node:assert/strict'
import { probeCudaPipelineCapability } from '../src/main/core/nvenc.mjs'

test('probeCudaPipelineCapability reports an unavailable pipeline when bundled FFmpeg lacks pad_cuda', async () => {
  let args = []
  const result = await probeCudaPipelineCapability('ffmpeg', {
    run: async (_ffmpegPath, receivedArgs) => {
      args = receivedArgs
      const error = new Error("Unknown filter 'pad_cuda'")
      error.stderrTail = "Unknown filter 'pad_cuda'"
      throw error
    }
  })

  assert.equal(result.available, false)
  assert.match(result.reason, /Unknown filter 'pad_cuda'/)
  assert.ok(args.includes('-filter_complex'))
  assert.ok(
    args.includes(
      '[0:v]format=nv12,hwupload_cuda,scale_cuda=w=320:h=240,pad_cuda=w=320:h=240:x=0:y=0[v]'
    )
  )
})

test('probeCudaPipelineCapability uses the available CUDA pipeline when its smoke test succeeds', async () => {
  const result = await probeCudaPipelineCapability('ffmpeg', { run: async () => {} })

  assert.deepEqual(result, { available: true, reason: '' })
})
