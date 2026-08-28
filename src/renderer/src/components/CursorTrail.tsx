import { useEffect, useRef } from 'react'
import type { CursorEffectsMode } from '../../../shared/types'

/**
 * 光标轨迹特效层（参考 Magic UI / CodePen 粒子轨迹的实现思路）：
 * - particles：沿指针移动路径播撒强调色光点，带惯性漂移与淡出
 * - ribbon：最近一段指针路径绘制为逐渐变细、淡出的霓虹拖尾
 * - 两种模式下点击（pointerdown）都会触发一圈小迸溅
 * 性能约束：粒子预渲染为离屏精灵、总量设上限、空闲即停帧、隐藏即清空；
 * 系统开启「减少动态效果」时整层关闭。仅响应鼠标 / 手写笔，不干扰触屏滚动。
 */

const MAX_PARTICLES = 220
const SPAWN_SPACING_PX = 5
const RIBBON_MAX_POINTS = 26
const RIBBON_LIFE_MS = 420
const BURST_COUNT = 14
const IDLE_STOP_MS = 160

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  ttl: number
  size: number
  /** trail 轻漂移 / burst 点击迸溅（衰减更快） */
  kind: 'trail' | 'burst'
}

type RibbonPoint = { x: number; y: number; t: number }

function hexToRgb(color: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** 将当前强调色预渲染为径向渐变精灵，避免每粒子每帧构建渐变对象。 */
function makeGlowSprite(rgb: [number, number, number]): HTMLCanvasElement {
  const size = 64
  const sprite = document.createElement('canvas')
  sprite.width = size
  sprite.height = size
  const context = sprite.getContext('2d')
  if (context) {
    const [r, g, b] = rgb
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2
    )
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)')
    gradient.addColorStop(0.25, `rgba(${r}, ${g}, ${b}, 0.75)`)
    gradient.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, 0.28)`)
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
    context.fillStyle = gradient
    context.fillRect(0, 0, size, size)
  }
  return sprite
}

function readAccent(): { sprite: HTMLCanvasElement; rgb: [number, number, number] } {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent')
  const rgb = hexToRgb(raw) ?? [22, 119, 255]
  return { sprite: makeGlowSprite(rgb), rgb }
}

function CursorTrail(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    let mode: CursorEffectsMode = 'particles'
    let enabled = true
    let rafId = 0
    let running = false
    let lastFrameAt = 0
    let lastPointerAt = 0
    let { sprite, rgb: accentRgb } = readAccent()

    const particles: Particle[] = []
    const ribbon: RibbonPoint[] = []
    const pointer = { x: 0, y: 0, has: false, vx: 0, vy: 0 }
    let pendingDistance = 0

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    enabled = !motionQuery.matches

    const stopLoop = (): void => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      running = false
    }

    const clearAll = (): void => {
      particles.length = 0
      ribbon.length = 0
      pendingDistance = 0
      context.clearRect(0, 0, canvas.width, canvas.height)
    }

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(window.innerWidth * dpr)
      canvas.height = Math.round(window.innerHeight * dpr)
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const spawnTrailParticles = (x: number, y: number, distance: number): void => {
      pendingDistance += distance
      while (pendingDistance >= SPAWN_SPACING_PX && particles.length < MAX_PARTICLES) {
        pendingDistance -= SPAWN_SPACING_PX
        particles.push({
          x: x + (Math.random() - 0.5) * 6,
          y: y + (Math.random() - 0.5) * 6,
          // 继承一小部分指针速度，形成随拖动方向甩开的惯性尾迹
          vx: pointer.vx * 0.08 + (Math.random() - 0.5) * 34,
          vy: pointer.vy * 0.08 + (Math.random() - 0.5) * 34 - 12,
          age: 0,
          ttl: 420 + Math.random() * 420,
          size: 5 + Math.random() * 9,
          kind: 'trail'
        })
      }
    }

    const spawnBurst = (x: number, y: number): void => {
      for (let i = 0; i < BURST_COUNT && particles.length < MAX_PARTICLES; i += 1) {
        const angle = Math.random() * Math.PI * 2
        const speed = 60 + Math.random() * 220
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          age: 0,
          ttl: 320 + Math.random() * 380,
          size: 4 + Math.random() * 8,
          kind: 'burst'
        })
      }
    }

    const drawParticles = (dt: number): void => {
      const damping = Math.exp(-dt * 2.2)
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i]
        p.age += dt * 1000
        if (p.age >= p.ttl) {
          particles.splice(i, 1)
          continue
        }
        p.vx *= damping
        p.vy *= damping
        // trail 光点轻微上浮，burst 更受衰减影响
        p.vy += (p.kind === 'trail' ? -14 : 60) * dt
        p.x += p.vx * dt
        p.y += p.vy * dt
        const remain = 1 - p.age / p.ttl
        const alpha = p.kind === 'trail' ? remain * 0.55 : remain * 0.75
        const size = p.size * (p.kind === 'trail' ? 0.6 + remain * 0.4 : remain)
        context.globalAlpha = alpha
        context.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size)
      }
      context.globalAlpha = 1
    }

    const drawRibbon = (now: number): void => {
      while (ribbon.length > 0 && now - ribbon[0].t > RIBBON_LIFE_MS) ribbon.shift()
      if (ribbon.length < 2) return
      context.lineCap = 'round'
      context.lineJoin = 'round'
      for (let i = 1; i < ribbon.length; i += 1) {
        const from = ribbon[i - 1]
        const to = ribbon[i]
        const life = 1 - (now - to.t) / RIBBON_LIFE_MS
        if (life <= 0) continue
        context.globalAlpha = life * 0.5
        context.lineWidth = Math.max(0.5, life * 10)
        context.strokeStyle = `rgb(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]})`
        context.beginPath()
        context.moveTo(from.x, from.y)
        context.lineTo(to.x, to.y)
        context.stroke()
      }
      context.globalAlpha = 1
    }

    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - lastFrameAt) / 1000 || 0.016)
      lastFrameAt = now
      context.clearRect(0, 0, canvas.width, canvas.height)
      if (mode === 'ribbon') drawRibbon(now)
      // 点击迸溅在两种模式下都保留
      if (particles.length > 0) drawParticles(dt)
      const idle = now - lastPointerAt > IDLE_STOP_MS && ribbon.length === 0
      if (particles.length === 0 && idle) {
        running = false
        rafId = 0
        context.clearRect(0, 0, canvas.width, canvas.height)
        return
      }
      rafId = requestAnimationFrame(tick)
    }

    const ensureLoop = (): void => {
      if (running) return
      running = true
      lastFrameAt = performance.now()
      rafId = requestAnimationFrame(tick)
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (!enabled || mode === 'off') return
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
      const now = performance.now()
      if (pointer.has) {
        const dt = Math.max((now - lastPointerAt) / 1000, 0.004)
        pointer.vx = (event.clientX - pointer.x) / dt
        pointer.vy = (event.clientY - pointer.y) / dt
        // 限制单次补间速度，避免窗口遮挡导致的跳帧拉出长粒子带
        const cap = 2600
        pointer.vx = Math.max(-cap, Math.min(cap, pointer.vx))
        pointer.vy = Math.max(-cap, Math.min(cap, pointer.vy))
      } else {
        pointer.vx = 0
        pointer.vy = 0
      }
      if (mode === 'particles' && pointer.has) {
        spawnTrailParticles(
          event.clientX,
          event.clientY,
          Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y)
        )
      }
      if (mode === 'ribbon') {
        ribbon.push({ x: event.clientX, y: event.clientY, t: now })
        if (ribbon.length > RIBBON_MAX_POINTS) ribbon.shift()
      }
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.has = true
      lastPointerAt = now
      ensureLoop()
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (!enabled || mode === 'off') return
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
      spawnBurst(event.clientX, event.clientY)
      ensureLoop()
    }

    const onVisibilityChange = (): void => {
      if (document.hidden) {
        stopLoop()
        clearAll()
      }
    }

    const syncMode = (next: CursorEffectsMode | undefined): void => {
      const resolved: CursorEffectsMode = next ?? 'particles'
      if (resolved !== mode) {
        mode = resolved
        clearAll()
      }
    }

    const onMotionPreferenceChange = (): void => {
      enabled = !motionQuery.matches
      if (!enabled) {
        stopLoop()
        clearAll()
      }
    }

    const unsubscribeSettings = window.api.onSettingsChange((settings) =>
      syncMode(settings.cursorEffects)
    )
    void window.api
      .getSettings()
      .then((settings) => syncMode(settings.cursorEffects))
      .catch(() => {})

    // 主题/色板切换会改写根节点 dataset 或内联 --accent，精灵与描边色跟随重建
    const themeObserver = new MutationObserver(() => {
      const next = readAccent()
      sprite = next.sprite
      accentRgb = next.rgb
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-palette', 'data-theme', 'style']
    })

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', onVisibilityChange)
    motionQuery.addEventListener('change', onMotionPreferenceChange)

    return () => {
      stopLoop()
      clearAll()
      unsubscribeSettings()
      themeObserver.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      motionQuery.removeEventListener('change', onMotionPreferenceChange)
    }
  }, [])

  return <canvas ref={canvasRef} className="cursor-trail-canvas" aria-hidden="true" />
}

export default CursorTrail
