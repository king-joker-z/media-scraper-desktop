import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isMediaPathAllowed,
  mediaUrlPathToLocal,
  normalizeMediaPath
} from '../src/main/core/media-path.mjs'

test('normalizeMediaPath unifies separators, Windows case and trailing slashes', () => {
  assert.equal(normalizeMediaPath('C:\\Users\\Alice\\Videos\\'), 'c:/users/alice/videos')
  assert.equal(normalizeMediaPath('c:/Users/ALICE'), 'c:/users/alice')
  assert.equal(normalizeMediaPath('/Volumes/nas/movies/'), '/Volumes/nas/movies')
  // UNC：反斜杠形态归一为双斜杠正斜杠，并按 Windows 规则忽略大小写
  assert.equal(normalizeMediaPath('\\\\NAS\\MediaShare\\Movies'), '//nas/mediashare/movies')
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

test('isMediaPathAllowed accepts Windows workspace subtree across separator and case variants', () => {
  const roots = ['C:\\Users\\Alice\\Videos']
  assert.equal(isMediaPathAllowed('C:/Users/Alice/Videos/a/b.mp4', roots), true)
  // Chromium / file:// 与目录选择器可能保留不同大小写，Windows 上应仍视为同一路径。
  assert.equal(isMediaPathAllowed('c:/users/alice/videos/合集/第一集.MP4', roots), true)
  assert.equal(isMediaPathAllowed('C:/USERS/ALICE/VIDEOS', roots), true)
  // 越界与「前缀但不同目录」拒绝
  assert.equal(isMediaPathAllowed('C:/Users/Alice/Videos2/x.mp4', roots), false)
  assert.equal(isMediaPathAllowed('D:/other/x.mp4', roots), false)
})

test('isMediaPathAllowed handles UNC roots case-insensitively without share-prefix escapes', () => {
  const roots = ['\\\\NAS\\MediaShare\\Movies']
  assert.equal(isMediaPathAllowed('//nas/mediashare/movies/a.mp4', roots), true)
  assert.equal(isMediaPathAllowed('\\\\NAS\\MEDIASHARE\\MOVIES\\sub\\b.mp4', roots), true)
  assert.equal(isMediaPathAllowed('//NAS/MediaShare/Movies-archive/a.mp4', roots), false)
  assert.equal(isMediaPathAllowed('//NAS/other/a.mp4', roots), false)
})
