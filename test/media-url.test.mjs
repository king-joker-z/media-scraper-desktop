import test from 'node:test'
import assert from 'node:assert/strict'
import { mediaUrl } from '../src/shared/media-url.mjs'
import {
  isMediaPathAllowed,
  mediaUrlPathToLocal,
  normalizeMediaPath
} from '../src/main/core/media-path.mjs'

/** 模拟 media:// 协议处理器从请求 URL 取得路径的完整边界。 */
const decodeMediaRequest = (absolutePath) => {
  const url = new URL(mediaUrl(absolutePath))
  return {
    url,
    decodedPath: decodeURIComponent(url.pathname),
    localPath: mediaUrlPathToLocal(decodeURIComponent(url.pathname))
  }
}

test('Windows drive media URL roundtrip keeps the drive in pathname and passes allowlist', () => {
  const source = 'C:\\媒体库\\海报 #1?.jpg'
  const { url, decodedPath, localPath } = decodeMediaRequest(source)

  assert.equal(url.hostname, 'local')
  assert.equal(decodedPath, '/C:/媒体库/海报 #1?.jpg')
  // 在 POSIX CI 上不能用本机 resolve 还原 Windows 盘符；白名单比较本身是跨平台纯规则。
  assert.equal(isMediaPathAllowed('c:/媒体库/海报 #1?.jpg', ['C:\\媒体库']), true)
  if (process.platform === 'win32') {
    assert.equal(localPath, 'C:\\媒体库\\海报 #1?.jpg')
    assert.equal(isMediaPathAllowed(localPath, ['C:\\媒体库']), true)
  }
})

test('UNC media URL roundtrip preserves server share and passes allowlist', () => {
  const source = '\\\\NAS\\漫画库\\第 01 话\\封面 #1.jpg'
  const { url, decodedPath, localPath } = decodeMediaRequest(source)

  assert.equal(url.hostname, 'local')
  assert.equal(decodedPath, '//NAS/漫画库/第 01 话/封面 #1.jpg')
  assert.equal(isMediaPathAllowed('//nas/漫画库/第 01 话/封面 #1.jpg', ['\\\\NAS\\漫画库']), true)
  if (process.platform === 'win32') {
    assert.equal(normalizeMediaPath(localPath), '//nas/漫画库/第 01 话/封面 #1.jpg')
    assert.equal(isMediaPathAllowed(localPath, ['\\\\NAS\\漫画库']), true)
  }
})

test('media URL encodes reserved URL characters as pathname data', () => {
  const { url, decodedPath } = decodeMediaRequest('D:\\视频?#%\\封面 #?.jpg')
  assert.equal(url.hostname, 'local')
  assert.equal(url.search, '')
  assert.equal(url.hash, '')
  assert.equal(decodedPath, '/D:/视频?#%/封面 #?.jpg')
})
