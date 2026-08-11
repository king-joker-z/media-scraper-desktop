import type { ThemeMode, ThemePalette } from '../../../shared/types'

/**
 * 应用外观到根节点：明暗模式与强调色分离，主题色切换不影响内容与风险色语义。
 * system 时不设 data-theme，交由 prefers-color-scheme 媒体查询决定。
 */
export function applyTheme(theme: ThemeMode, palette: ThemePalette = 'ocean'): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
  document.documentElement.dataset.palette = palette
}
