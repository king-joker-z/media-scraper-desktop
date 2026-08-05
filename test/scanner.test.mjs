import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPath, isHiddenName, normalizedName } from '../src/main/scanner.mjs'

test('classifies mainstream media extensions', () => {
  assert.equal(classifyPath('movie.MKV'), 'video')
  assert.equal(classifyPath('poster.webp'), 'image')
  assert.equal(classifyPath('legacy.nfo'), 'other')
})

test('identifies hidden names and normalizes poster names', () => {
  assert.equal(isHiddenName('.DS_Store'), true)
  assert.equal(isHiddenName('video.mp4'), false)
  assert.equal(normalizedName('视频 6-poster.jpg'), normalizedName('视频_6.mp4'))
})
