import test from 'node:test'
import assert from 'node:assert/strict'

// 仅提取纯 URL 规则，避免在 Node 测试环境加载依赖浏览器 API 的整个工具模块。
const mediaUrl = (absolutePath) => {
  const normalized = absolutePath.replaceAll('\\', '/')
  const encoded = normalized.split('/').map(encodeURIComponent).join('/')
  return normalized.startsWith('//')
    ? `media://local${encoded}`
    : `media://local/${encoded.replace(/^\/+/, '')}`
}

test('mediaUrl places Windows drive paths in URL pathname rather than hostname', () => {
  const url = new URL(mediaUrl('C:\\媒体库\\封面 #1.jpg'))
  assert.equal(url.hostname, 'local')
  assert.equal(url.pathname, '/C%3A/%E5%AA%92%E4%BD%93%E5%BA%93/%E5%B0%81%E9%9D%A2%20%231.jpg')
  assert.equal(decodeURIComponent(url.pathname), '/C:/媒体库/封面 #1.jpg')
})

test('mediaUrl preserves UNC double-slash path', () => {
  const url = new URL(mediaUrl('\\\\NAS\\漫画\\封面.jpg'))
  assert.equal(url.hostname, 'local')
  assert.equal(decodeURIComponent(url.pathname), '//NAS/漫画/封面.jpg')
})
