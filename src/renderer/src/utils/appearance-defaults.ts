import type { CursorEffectsMode, PerformanceMode } from '../../../shared/types'

/**
 * 渲染进程的外观兜底值，须与主进程 settings 的平台默认保持一致。
 * 仅在调用时读取 navigator，测试或非浏览器环境可传入 userAgent，避免模块加载阶段访问浏览器全局。
 */
export function getPlatformAppearanceDefaults(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
): { cursorEffects: CursorEffectsMode; performanceMode: PerformanceMode } {
  const isWindows = /Windows/i.test(userAgent)
  return {
    cursorEffects: isWindows ? 'off' : 'particles',
    performanceMode: isWindows ? 'reduced' : 'standard'
  }
}
