import type { ThemeMode } from '../../../shared/types'

/**
 * 应用主题到根节点：data-theme 属性驱动 CSS 变量覆盖。
 * system 时不设属性，交由 prefers-color-scheme 媒体查询决定。
 */
export function applyTheme(theme: ThemeMode): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
}
