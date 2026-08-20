import test from 'node:test'
import assert from 'node:assert/strict'
import { probeCudaPipelineCapability } from '../src/main/core/nvenc.mjs'

test('probeCudaPipelineCapability uses overlay_cuda rather than the nonexistent pad_cuda filter', async () => {
  let args = []
  const result = await probeCudaPipelineCapability('ffmpeg', {
    run: async (_ffmpegPath, receivedArgs) => {
      args = receivedArgs
    }
  })

  assert.deepEqual(result, { available: true, reason: '' })
  const filterGraph = args[args.indexOf('-filter_complex') + 1]
  assert.match(filterGraph, /scale_cuda=/)
  assert.match(filterGraph, /overlay_cuda=/)
  assert.doesNotMatch(filterGraph, /pad_cuda/)
  assert.match(filterGraph, /hwupload_cuda/)
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '[v]'])
  assert.equal(args.includes('-pix_fmt'), false)
})

test('probeCudaPipelineCapability preserves FFmpeg capability errors for the UI', async () => {
  const result = await probeCudaPipelineCapability('ffmpeg', {
    run: async () => {
      const error = new Error("No such filter: 'overlay_cuda'")
      error.stderrTail = "No such filter: 'overlay_cuda'"
      throw error
    }
  })

  assert.equal(result.available, false)
  assert.match(result.reason, /overlay_cuda/)
})
