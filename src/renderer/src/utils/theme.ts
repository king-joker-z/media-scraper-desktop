import type { BackgroundAppearance, ThemeMode, ThemePalette } from '../../../shared/types'
import { mediaUrl } from './media'

/**
 * 应用外观到根节点：明暗模式与强调色分离，主题色切换不影响内容与风险色语义。
 * system 时不设 data-theme，交由 prefers-color-scheme 媒体查询决定。
 */
/**
 * 兼容主进程尚未热重载、或旧版本配置缺失该字段时的安全默认值。
 * 主进程会在下次写入时将其规范化并持久化。
 */
export const DEFAULT_BACKGROUND_APPEARANCE: BackgroundAppearance = {
  imagePath: '',
  imageOpacity: 32,
  blur: 8,
  surfaceOpacity: 35,
  fit: 'cover'
}

/** 将背景图片和材质参数映射为 CSS 变量，避免高频调节导致 React 树重渲染。 */
export function applyBackgroundAppearance(appearance?: BackgroundAppearance): void {
  const next = appearance ?? DEFAULT_BACKGROUND_APPEARANCE
  const root = document.documentElement
  const image = next.imagePath ? `url("${mediaUrl(next.imagePath)}")` : 'none'
  root.style.setProperty('--workspace-background-image', image)
  root.style.setProperty('--workspace-background-opacity', String(next.imageOpacity / 100))
  root.style.setProperty('--workspace-background-blur', `${next.blur}px`)
  root.style.setProperty('--workspace-surface-opacity', String(next.surfaceOpacity / 100))
  root.style.setProperty('--workspace-background-size', next.fit)
}

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
