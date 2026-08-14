import type { ThemeMode, ThemePalette } from '../../../shared/types'

/**
 * 应用外观到根节点：明暗模式与强调色分离，主题色切换不影响内容与风险色语义。
 * system 时不设 data-theme，交由 prefers-color-scheme 媒体查询决定。
 */
export function applyTheme(
  theme: ThemeMode,
  palette: ThemePalette = 'ocean',
  customAccent = '#1687d9'
): void {
  const root = document.documentElement
  if (theme === 'system') {
    delete root.dataset.theme
  } else {
    root.dataset.theme = theme
  }
  root.dataset.palette = palette
  if (palette === 'custom') {
    root.style.setProperty('--accent', customAccent)
    root.style.setProperty('--accent-press', `color-mix(in srgb, ${customAccent} 80%, #000)`)
    root.style.setProperty('--accent-soft', `color-mix(in srgb, ${customAccent} 13%, transparent)`)
    root.style.setProperty('--focus-ring', `color-mix(in srgb, ${customAccent} 32%, transparent)`)
  } else {
    root.style.removeProperty('--accent')
    root.style.removeProperty('--accent-press')
    root.style.removeProperty('--accent-soft')
    root.style.removeProperty('--focus-ring')
  }
}
