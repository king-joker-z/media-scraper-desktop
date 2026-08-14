import assert from 'node:assert/strict'
import test from 'node:test'
import { basename, join, relative, resolve } from 'node:path'
import { assertSafeFileName, resolveInsideRoot } from '../src/main/core/path-guard.mjs'

test('resolveInsideRoot accepts normal relative paths and rejects traversal', () => {
  assert.equal(basename(resolveInsideRoot('/workspace', 'nested/video.mp4')), 'video.mp4')
  assert.equal(
    relative(resolve('/workspace'), resolveInsideRoot('/workspace', 'nested/video.mp4')),
    join('nested', 'video.mp4')
  )
  assert.throws(() => resolveInsideRoot('/workspace', '../outside.mp4'), /超出工作区/)
  assert.throws(() => resolveInsideRoot('/workspace', '/outside.mp4'), /绝对路径/)
})

test('resolveInsideRoot rejects Windows drive and root-relative path forms on every platform', () => {
  const paths = [
    '\\Windows\\System32\\outside.mp4',
    '\\\\server\\share\\outside.mp4',
    'C:outside.mp4',
    'C:\\outside.mp4',
    'D:/outside.mp4'
  ]
  for (const path of paths) {
    assert.throws(() => resolveInsideRoot('/workspace', path), /绝对路径/, path)
  }
  const nestedBackslashPath = resolveInsideRoot('/workspace', 'nested\\video.mp4')
  assert.equal(
    relative(resolve('/workspace'), nestedBackslashPath),
    process.platform === 'win32' ? join('nested', 'video.mp4') : 'nested\\video.mp4'
  )
})

test('assertSafeFileName rejects nested and traversal output names', () => {
  assert.equal(assertSafeFileName('merged.mp4'), 'merged.mp4')
  assert.throws(() => assertSafeFileName('../merged.mp4'), /无效/)
  assert.throws(() => assertSafeFileName('folder/merged.mp4'), /无效/)
})
