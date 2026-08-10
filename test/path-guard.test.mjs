import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSafeFileName, resolveInsideRoot } from '../src/main/core/path-guard.mjs'

test('resolveInsideRoot accepts normal relative paths and rejects traversal', () => {
  assert.equal(resolveInsideRoot('/workspace', 'nested/video.mp4'), '/workspace/nested/video.mp4')
  assert.throws(() => resolveInsideRoot('/workspace', '../outside.mp4'), /超出工作区/)
  assert.throws(() => resolveInsideRoot('/workspace', '/outside.mp4'), /绝对路径/)
})

test('assertSafeFileName rejects nested and traversal output names', () => {
  assert.equal(assertSafeFileName('merged.mp4'), 'merged.mp4')
  assert.throws(() => assertSafeFileName('../merged.mp4'), /无效/)
  assert.throws(() => assertSafeFileName('folder/merged.mp4'), /无效/)
})
