import { useEffect } from 'react'

/**
 * 聚光悬停（Spotlight Card，参考 Vercel / Linear 官网的卡片光标光斑）：
 * 事件委托监听全局 pointermove，命中最近的 [data-spotlight] 元素后，
 * 把指针在元素内的坐标写入 --spotlight-x / --spotlight-y 两个 CSS 变量，
 * 由样式层 ::after 的径向渐变消费。零 React 状态、无重渲染，
 * 坐标写入经 rAF 合并，动态插入的卡片自动生效。
 */
export function useSpotlightHover(): void {
  useEffect(() => {
    let rafId = 0
    let pendingTarget: HTMLElement | null = null
    let pendingEvent: PointerEvent | null = null
    let lastTarget: HTMLElement | null = null

    const flush = (): void => {
      rafId = 0
      const target = pendingTarget
      const event = pendingEvent
      pendingTarget = null
      pendingEvent = null
      if (!target || !event || !target.isConnected) {
        lastTarget = null
        return
      }
      const rect = target.getBoundingClientRect()
      target.style.setProperty('--spotlight-x', `${event.clientX - rect.left}px`)
      target.style.setProperty('--spotlight-y', `${event.clientY - rect.top}px`)
      lastTarget = target
    }

    const schedule = (target: HTMLElement, event: PointerEvent): void => {
      pendingTarget = target
      pendingEvent = event
      if (!rafId) rafId = requestAnimationFrame(flush)
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse') return
      const target =
        event.target instanceof Element ? event.target.closest('[data-spotlight]') : null
      if (target instanceof HTMLElement) {
        schedule(target, event)
      } else if (lastTarget) {
        lastTarget = null
      }
    }

    const onPointerOut = (event: PointerEvent): void => {
      const target =
        event.target instanceof Element ? event.target.closest('[data-spotlight]') : null
      if (target instanceof HTMLElement && !target.contains(event.relatedTarget as Node | null)) {
        target.style.setProperty('--spotlight-x', '-999px')
        target.style.setProperty('--spotlight-y', '-999px')
        if (lastTarget === target) lastTarget = null
      }
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerout', onPointerOut, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerout', onPointerOut)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])
}
