import test from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedMainFrameNavigation } from '../src/shared/navigation-rules.mjs'

test('开发入口只允许同一 Vite origin 的主窗口导航', () => {
  const entry = 'http://localhost:5173/'
  assert.equal(isAllowedMainFrameNavigation('http://localhost:5173/settings', entry), true)
  assert.equal(isAllowedMainFrameNavigation('http://localhost:4173/', entry), false)
  assert.equal(isAllowedMainFrameNavigation('https://example.com/', entry), false)
})

test('生产入口只允许当前应用 HTML 文件', () => {
  const entry =
    'file:///Applications/Media%20Scraper.app/Contents/Resources/app/renderer/index.html'
  assert.equal(isAllowedMainFrameNavigation(entry, entry), true)
  assert.equal(
    isAllowedMainFrameNavigation(
      'file:///Applications/Media%20Scraper.app/Contents/Resources/app/evil.html',
      entry
    ),
    false
  )
  assert.equal(isAllowedMainFrameNavigation('https://example.com/', entry), false)
})
