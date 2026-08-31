import test from 'node:test'
import assert from 'node:assert/strict'
import { getPlatformAppearanceDefaults } from '../src/renderer/src/utils/appearance-defaults.ts'

test('渲染端外观默认值与 Windows 主进程默认一致', () => {
  assert.deepEqual(
    getPlatformAppearanceDefaults(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0'
    ),
    { cursorEffects: 'off', performanceMode: 'reduced' }
  )
})

test('渲染端外观默认值为非 Windows 平台保留完整效果', () => {
  assert.deepEqual(
    getPlatformAppearanceDefaults(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Safari/605.1.15'
    ),
    { cursorEffects: 'particles', performanceMode: 'standard' }
  )
})
