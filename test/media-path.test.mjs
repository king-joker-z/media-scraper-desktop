import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isMediaPathAllowed,
  mediaUrlPathToLocal,
  normalizeMediaPath
} from '../src/main/core/media-path.mjs'

test('normalizeMediaPath unifies separators, drive case and trailing slashes', () => {
  assert.equal(normalizeMediaPath('C:\\Users\\me\\videos\\'), 'C:/Users/me/videos')
  assert.equal(normalizeMediaPath('c:/Users/me'), 'C:/Users/me')
  assert.equal(normalizeMediaPath('/Volumes/nas/movies/'), '/Volumes/nas/movies')
  // UNC：反斜杠形态归一为双斜杠正斜杠形态
  assert.equal(normalizeMediaPath('\\\\NAS\\share\\movies'), '//NAS/share/movies')
})

test('mediaUrlPathToLocal strips drive-letter leading slash and resolves traversal', () => {
  if (process.platform === 'win32') {
    assert.equal(mediaUrlPathToLocal('/C:/ws/a.mp4'), 'C:\\ws\\a.mp4')
    // UNC：双斜杠开头被 win32 resolve 识别为 UNC
    assert.equal(mediaUrlPathToLocal('//NAS/share/a.mp4'), '\\\\NAS\\share\\a.mp4')
    // 路径穿越被 resolve 归一
    assert.equal(mediaUrlPathToLocal('/C:/ws/../elsewhere/x.mp4'), 'C:\\elsewhere\\x.mp4')
  } else {
    assert.equal(mediaUrlPathToLocal('/Volumes/nas/a.mp4'), '/Volumes/nas/a.mp4')
    assert.equal(mediaUrlPathToLocal('/ws/../elsewhere/x.mp4'), '/elsewhere/x.mp4')
  }
})

test('isMediaPathAllowed accepts workspace subtree regardless of separator style', () => {
  const roots = ['C:\\Users\\me\\videos']
  assert.equal(isMediaPathAllowed('C:/Users/me/videos/a/b.mp4', roots), true)
  assert.equal(
    isMediaPathAllowed('c:/users/me/videos/x.mp4'.replace('c:/users', 'C:/Users'), roots),
    true
  )
  assert.equal(isMediaPathAllowed('C:/Users/me/videos', roots), true)
  // 越界与「前缀但不同目录」拒绝
  assert.equal(isMediaPathAllowed('C:/Users/me/videos2/x.mp4', roots), false)
  assert.equal(isMediaPathAllowed('D:/other/x.mp4', roots), false)
})

test('isMediaPathAllowed handles UNC roots', () => {
  const roots = ['\\\\NAS\\share\\movies']
  assert.equal(isMediaPathAllowed('//NAS/share/movies/a.mp4', roots), true)
  assert.equal(isMediaPathAllowed('\\\\NAS\\share\\movies\\sub\\b.mp4', roots), true)
  assert.equal(isMediaPathAllowed('//NAS/other/a.mp4', roots), false)
})
