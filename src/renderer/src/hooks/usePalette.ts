import { useSyncExternalStore } from 'react'
import type { ThemePalette } from '../../../shared/types'

/**
 * 订阅根节点 data-palette 变化：applyTheme 在设置页预览/保存时直接改 DOM
 * 属性（不经过 React 状态），因此用 MutationObserver + useSyncExternalStore
 * 让组件树能按皮肤渲染完全不同的 DOM 结构（而非只靠 CSS 换色）。
 */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-palette']
  })
  return () => observer.disconnect()
}

function getSnapshot(): ThemePalette {
  return (document.documentElement.dataset.palette as ThemePalette | undefined) ?? 'ocean'
}

export function usePalette(): ThemePalette {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** 当前是否为作战终端皮肤（terminal）——差异化组件分支的快捷判断。 */
export function useTerminalPalette(): boolean {
  return usePalette() === 'terminal'
}
