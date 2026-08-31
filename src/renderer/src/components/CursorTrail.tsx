import { useEffect, useRef } from 'react'
import type { CursorEffectsMode } from '../../../shared/types'
import { getPlatformAppearanceDefaults } from '../utils/appearance-defaults'

/**
 * 光标动效层（单 Canvas）：
 * - particles：轻量惯性光点
 * - ribbon：霓虹线条笔触
 * - sparkles：缓慢浮动、明暗呼吸的星芒
 * - comets：沿指针方向划出的短彗尾
 * - confetti：跟随主题色的纸片飘落
 * - ripples：点击时层叠扩散的水波圆环
 *
 * 性能边界：离屏精灵、全局粒子上限、rAF 合帧、空闲停帧、页面隐藏清空；
 * 系统“减少动态效果”时整层关闭。只监听 mouse / pen，触屏滚动不受影响。
 */

const MAX_PARTICLES = 220
const REDUCED_MAX_PARTICLES = 70
const MAX_RIPPLES = 14
const RIBBON_MAX_POINTS = 26
const RIBBON_LIFE_MS = 420
const IDLE_STOP_MS = 160

const PATH_SPACING: Partial<Record<CursorEffectsMode, number>> = {
  particles: 5,
  sparkles: 17,
  comets: 26,
  confetti: 14
}

type ParticleKind = 'trail' | 'burst' | 'sparkle' | 'comet' | 'confetti'

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  ttl: number
  size: number
  kind: ParticleKind
  rotation: number
  angularVelocity: number
  colorIndex: number
}

type RibbonPoint = { x: number; y: number; t: number }

type Ripple = {
  x: number
  y: number
  age: number
  ttl: number
  maxRadius: number
  lineWidth: number
}

type AccentAssets = {
  sprite: HTMLCanvasElement
  rgb: [number, number, number]
  colors: string[]
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function hexToRgb(color: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function mixRgb(
  [fromR, fromG, fromB]: [number, number, number],
  [toR, toG, toB]: [number, number, number],
  amount: number
): [number, number, number] {
  return [
    Math.round(fromR + (toR - fromR) * amount),
    Math.round(fromG + (toG - fromG) * amount),
    Math.round(fromB + (toB - fromB) * amount)
  ]
}

function rgbColor([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
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

function readAccent(): AccentAssets {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent')
  const rgb = hexToRgb(raw) ?? [22, 119, 255]
  // 彩纸碎屑只使用同一主题色的明暗变体，避免突兀的固定彩虹色。
  const colors = [
    rgbColor(rgb),
    rgbColor(mixRgb(rgb, [255, 255, 255], 0.35)),
    rgbColor(mixRgb(rgb, [0, 0, 0], 0.22))
  ]
  return { sprite: makeGlowSprite(rgb), rgb, colors }
}

function CursorTrail(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    let mode: CursorEffectsMode = 'particles'
    let enabled = true
    let isReduced = false
    let isTaskBusy = false
    let rafId = 0
    let running = false
    let lastFrameAt = 0
    let lastPointerAt = 0
    let viewportWidth = window.innerWidth
    let viewportHeight = window.innerHeight
    let { sprite, rgb: accentRgb, colors: accentColors } = readAccent()

    const particles: Particle[] = []
    const ribbon: RibbonPoint[] = []
    const ripples: Ripple[] = []
    const pointer = { x: 0, y: 0, has: false, vx: 0, vy: 0 }
    let pendingDistance = 0

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    enabled = !motionQuery.matches

    const clearCanvas = (): void => {
      context.clearRect(0, 0, viewportWidth, viewportHeight)
    }

    const stopLoop = (): void => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      running = false
    }

    const clearAll = (): void => {
      particles.length = 0
      ribbon.length = 0
      ripples.length = 0
      pendingDistance = 0
      pointer.has = false
      clearCanvas()
    }

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, isReduced ? 1 : 2)
      viewportWidth = window.innerWidth
      viewportHeight = window.innerHeight
      canvas.width = Math.round(viewportWidth * dpr)
      canvas.height = Math.round(viewportHeight * dpr)
      canvas.style.width = `${viewportWidth}px`
      canvas.style.height = `${viewportHeight}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const particleLimit = (): number => (isReduced ? REDUCED_MAX_PARTICLES : MAX_PARTICLES)

    const addParticle = (particle: Particle): void => {
      if (particles.length < particleLimit()) particles.push(particle)
    }

    const spawnTrailParticle = (x: number, y: number): void => {
      addParticle({
        x: x + randomBetween(-3, 3),
        y: y + randomBetween(-3, 3),
        // 继承少量指针速度，形成顺着移动方向甩开的惯性尾迹。
        vx: pointer.vx * 0.08 + randomBetween(-17, 17),
        vy: pointer.vy * 0.08 + randomBetween(-26, 8),
        age: 0,
        ttl: randomBetween(420, 840),
        size: randomBetween(5, 14),
        kind: 'trail',
        rotation: 0,
        angularVelocity: 0,
        colorIndex: 0
      })
    }

    const spawnSparkle = (x: number, y: number, burst = false): void => {
      const angle = burst ? Math.random() * Math.PI * 2 : 0
      const speed = burst ? randomBetween(45, 175) : randomBetween(4, 22)
      addParticle({
        x: x + randomBetween(-4, 4),
        y: y + randomBetween(-4, 4),
        vx: burst ? Math.cos(angle) * speed : pointer.vx * 0.025 + randomBetween(-8, 8),
        vy: burst ? Math.sin(angle) * speed : pointer.vy * 0.025 - randomBetween(12, 28),
        age: 0,
        ttl: randomBetween(550, 1050),
        size: randomBetween(4, 10),
        kind: 'sparkle',
        rotation: Math.random() * Math.PI,
        angularVelocity: randomBetween(-3, 3),
        colorIndex: Math.floor(Math.random() * accentColors.length)
      })
    }

    const spawnComet = (x: number, y: number, burst = false): void => {
      const velocityMagnitude = Math.hypot(pointer.vx, pointer.vy)
      const direction =
        burst || velocityMagnitude < 80
          ? Math.random() * Math.PI * 2
          : Math.atan2(pointer.vy, pointer.vx)
      const speed = burst ? randomBetween(160, 320) : clamp(velocityMagnitude * 0.16, 135, 310)
      addParticle({
        x,
        y,
        vx: Math.cos(direction) * speed + randomBetween(-16, 16),
        vy: Math.sin(direction) * speed + randomBetween(-16, 16),
        age: 0,
        ttl: randomBetween(260, 520),
        size: randomBetween(6, 11),
        kind: 'comet',
        rotation: direction,
        angularVelocity: 0,
        colorIndex: 0
      })
    }

    const spawnConfetti = (x: number, y: number, burst = false): void => {
      const angle = burst
        ? Math.random() * Math.PI * 2
        : Math.atan2(pointer.vy, pointer.vx) + randomBetween(-0.9, 0.9)
      const speed = burst ? randomBetween(90, 260) : randomBetween(50, 135)
      addParticle({
        x: x + randomBetween(-3, 3),
        y: y + randomBetween(-3, 3),
        vx: pointer.vx * 0.055 + Math.cos(angle) * speed,
        vy: pointer.vy * 0.055 + Math.sin(angle) * speed - randomBetween(15, 60),
        age: 0,
        ttl: randomBetween(780, 1450),
        size: randomBetween(5, 10),
        kind: 'confetti',
        rotation: Math.random() * Math.PI * 2,
        angularVelocity: randomBetween(-12, 12),
        colorIndex: Math.floor(Math.random() * accentColors.length)
      })
    }

    const spawnBurst = (x: number, y: number): void => {
      for (let i = 0; i < 14 && particles.length < particleLimit(); i += 1) {
        const angle = Math.random() * Math.PI * 2
        const speed = randomBetween(60, 220)
        addParticle({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          age: 0,
          ttl: randomBetween(320, 700),
          size: randomBetween(4, 12),
          kind: 'burst',
          rotation: 0,
          angularVelocity: 0,
          colorIndex: 0
        })
      }
    }

    const spawnModeBurst = (x: number, y: number): void => {
      if (mode === 'sparkles') {
        for (let i = 0; i < 11; i += 1) spawnSparkle(x, y, true)
        return
      }
      if (mode === 'comets') {
        for (let i = 0; i < 7; i += 1) spawnComet(x, y, true)
        return
      }
      if (mode === 'confetti') {
        for (let i = 0; i < 18; i += 1) spawnConfetti(x, y, true)
        return
      }
      spawnBurst(x, y)
    }

    const spawnRipple = (x: number, y: number, delay: number, scale: number): void => {
      if (ripples.length >= MAX_RIPPLES) ripples.shift()
      ripples.push({
        x,
        y,
        // 负数 age 充当延迟，不需要 setTimeout，也能随着页面隐藏一并安全清理。
        age: -delay,
        ttl: 560,
        maxRadius: 28 * scale,
        lineWidth: scale > 1 ? 1.3 : 1.7
      })
    }

    const spawnModePathEffect = (x: number, y: number, distance: number): void => {
      const spacing = PATH_SPACING[mode]
      if (!spacing) return
      pendingDistance += distance
      while (pendingDistance >= spacing && particles.length < particleLimit()) {
        pendingDistance -= spacing
        if (mode === 'particles') spawnTrailParticle(x, y)
        if (mode === 'sparkles') spawnSparkle(x, y)
        if (mode === 'comets') spawnComet(x, y)
        if (mode === 'confetti') spawnConfetti(x, y)
      }
    }

    const drawSparkle = (particle: Particle, alpha: number): void => {
      const pulse = 0.55 + 0.45 * Math.sin(particle.age * 0.018 + particle.rotation)
      const radius = particle.size * (0.45 + pulse * 0.6)
      context.save()
      context.translate(particle.x, particle.y)
      context.rotate(particle.rotation)
      context.globalAlpha = alpha * (0.55 + pulse * 0.45)
      context.strokeStyle = accentColors[particle.colorIndex] ?? accentColors[0]
      context.fillStyle = accentColors[particle.colorIndex] ?? accentColors[0]
      context.lineWidth = Math.max(0.65, radius * 0.15)
      context.beginPath()
      context.moveTo(-radius, 0)
      context.lineTo(radius, 0)
      context.moveTo(0, -radius)
      context.lineTo(0, radius)
      context.moveTo(-radius * 0.5, -radius * 0.5)
      context.lineTo(radius * 0.5, radius * 0.5)
      context.moveTo(radius * 0.5, -radius * 0.5)
      context.lineTo(-radius * 0.5, radius * 0.5)
      context.stroke()
      context.globalAlpha = alpha
      context.beginPath()
      context.arc(0, 0, Math.max(0.8, radius * 0.16), 0, Math.PI * 2)
      context.fill()
      context.restore()
    }

    const drawComet = (particle: Particle, alpha: number): void => {
      const speed = Math.hypot(particle.vx, particle.vy)
      const tailLength = clamp(speed * 0.11, 14, 38) * (1 - particle.age / particle.ttl)
      const direction = Math.atan2(particle.vy, particle.vx)
      context.save()
      context.globalAlpha = alpha * 0.72
      context.strokeStyle = `rgb(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]})`
      context.lineCap = 'round'
      context.lineWidth = Math.max(0.8, particle.size * 0.25)
      context.beginPath()
      context.moveTo(
        particle.x - Math.cos(direction) * tailLength,
        particle.y - Math.sin(direction) * tailLength
      )
      context.lineTo(particle.x, particle.y)
      context.stroke()
      context.globalAlpha = alpha
      context.drawImage(
        sprite,
        particle.x - particle.size / 2,
        particle.y - particle.size / 2,
        particle.size,
        particle.size
      )
      context.restore()
    }

    const drawConfetti = (particle: Particle, alpha: number): void => {
      context.save()
      context.translate(particle.x, particle.y)
      context.rotate(particle.rotation)
      context.globalAlpha = alpha * 0.88
      context.fillStyle = accentColors[particle.colorIndex] ?? accentColors[0]
      context.fillRect(
        -particle.size * 0.38,
        -particle.size * 0.72,
        particle.size * 0.76,
        particle.size * 1.44
      )
      context.restore()
    }

    const updateAndDrawParticles = (dt: number): void => {
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const particle = particles[i]
        particle.age += dt * 1000
        if (particle.age >= particle.ttl) {
          particles.splice(i, 1)
          continue
        }

        const damping = Math.exp(-dt * (particle.kind === 'confetti' ? 0.7 : 2.2))
        particle.vx *= damping
        particle.vy *= damping
        if (particle.kind === 'confetti') particle.vy += 330 * dt
        if (particle.kind === 'sparkle') particle.vy -= 7 * dt
        if (particle.kind === 'trail') particle.vy -= 14 * dt
        if (particle.kind === 'burst') particle.vy += 60 * dt
        particle.x += particle.vx * dt
        particle.y += particle.vy * dt
        particle.rotation += particle.angularVelocity * dt

        const remain = 1 - particle.age / particle.ttl
        const alpha = particle.kind === 'trail' ? remain * 0.55 : remain * 0.76
        if (particle.kind === 'sparkle') {
          drawSparkle(particle, alpha)
          continue
        }
        if (particle.kind === 'comet') {
          drawComet(particle, alpha)
          continue
        }
        if (particle.kind === 'confetti') {
          drawConfetti(particle, alpha)
          continue
        }
        const size = particle.size * (particle.kind === 'trail' ? 0.6 + remain * 0.4 : remain)
        context.globalAlpha = alpha
        context.drawImage(sprite, particle.x - size / 2, particle.y - size / 2, size, size)
      }
      context.globalAlpha = 1
    }

    const drawRibbon = (now: number): void => {
      while (ribbon.length > 0 && now - ribbon[0].t > RIBBON_LIFE_MS) ribbon.shift()
      if (ribbon.length < 2) return
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.strokeStyle = `rgb(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]})`
      for (let i = 1; i < ribbon.length; i += 1) {
        const from = ribbon[i - 1]
        const to = ribbon[i]
        const life = 1 - (now - to.t) / RIBBON_LIFE_MS
        if (life <= 0) continue
        context.globalAlpha = life * 0.5
        context.lineWidth = Math.max(0.5, life * 10)
        context.beginPath()
        context.moveTo(from.x, from.y)
        context.lineTo(to.x, to.y)
        context.stroke()
      }
      context.globalAlpha = 1
    }

    const updateAndDrawRipples = (dt: number): void => {
      for (let i = ripples.length - 1; i >= 0; i -= 1) {
        const ripple = ripples[i]
        ripple.age += dt * 1000
        if (ripple.age >= ripple.ttl) {
          ripples.splice(i, 1)
          continue
        }
        if (ripple.age < 0) continue
        const progress = ripple.age / ripple.ttl
        // ease-out 圆环，起始不突兀、末尾自然淡出。
        const radius = ripple.maxRadius * (1 - (1 - progress) * (1 - progress))
        context.globalAlpha = (1 - progress) * 0.68
        context.strokeStyle = `rgb(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]})`
        context.lineWidth = ripple.lineWidth * (1 - progress * 0.35)
        context.beginPath()
        context.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2)
        context.stroke()
      }
      context.globalAlpha = 1
    }

    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - lastFrameAt) / 1000 || 0.016)
      lastFrameAt = now
      clearCanvas()
      if (mode === 'ribbon') drawRibbon(now)
      if (particles.length > 0) updateAndDrawParticles(dt)
      if (ripples.length > 0) updateAndDrawRipples(dt)

      const hasEffect = particles.length > 0 || ribbon.length > 0 || ripples.length > 0
      const idle = now - lastPointerAt > IDLE_STOP_MS && ribbon.length === 0
      if (!hasEffect && idle) {
        running = false
        rafId = 0
        clearCanvas()
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
      if (!enabled || isTaskBusy || mode === 'off') return
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
      const now = performance.now()
      const distance = pointer.has
        ? Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y)
        : 0
      if (pointer.has) {
        const dt = Math.max((now - lastPointerAt) / 1000, 0.004)
        pointer.vx = clamp((event.clientX - pointer.x) / dt, -2600, 2600)
        pointer.vy = clamp((event.clientY - pointer.y) / dt, -2600, 2600)
      } else {
        pointer.vx = 0
        pointer.vy = 0
      }

      spawnModePathEffect(event.clientX, event.clientY, distance)
      if (mode === 'ribbon') {
        ribbon.push({ x: event.clientX, y: event.clientY, t: now })
        if (ribbon.length > RIBBON_MAX_POINTS) ribbon.shift()
      }
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.has = true
      lastPointerAt = now
      // 涟漪只由点击触发，移动时不唤醒 rAF。
      if (mode !== 'ripples') ensureLoop()
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (!enabled || isTaskBusy || mode === 'off') return
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
      lastPointerAt = performance.now()
      if (mode === 'ripples') {
        spawnRipple(event.clientX, event.clientY, 0, 0.8)
        spawnRipple(event.clientX, event.clientY, 110, 1.45)
      } else {
        spawnModeBurst(event.clientX, event.clientY)
      }
      ensureLoop()
    }

    const onVisibilityChange = (): void => {
      if (document.hidden) {
        stopLoop()
        clearAll()
      }
    }

    const syncMode = (next: CursorEffectsMode | undefined): void => {
      const resolved = next ?? getPlatformAppearanceDefaults().cursorEffects
      if (resolved !== mode) {
        mode = resolved
        stopLoop()
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

    const syncPerformanceState = (): void => {
      const root = document.documentElement
      const nextReduced = root.dataset.performanceMode === 'reduced'
      const nextTaskBusy = root.dataset.taskBusy === 'true'
      if (isReduced !== nextReduced) {
        isReduced = nextReduced
        resize()
      }
      if (isTaskBusy !== nextTaskBusy) {
        isTaskBusy = nextTaskBusy
        if (isTaskBusy) {
          stopLoop()
          clearAll()
        }
      }
    }

    const unsubscribeSettings = window.api.onSettingsChange((settings) =>
      syncMode(settings.cursorEffects)
    )
    void window.api
      .getSettings()
      .then((settings) => syncMode(settings.cursorEffects))
      .catch(() => {})

    // 主题/色板切换会改写根节点 dataset 或内联 --accent，精灵与绘制色随之重建。
    const themeObserver = new MutationObserver(() => {
      const next = readAccent()
      sprite = next.sprite
      accentRgb = next.rgb
      accentColors = next.colors
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        'data-palette',
        'data-theme',
        'data-performance-mode',
        'data-task-busy',
        'style'
      ]
    })
    const performanceObserver = new MutationObserver(syncPerformanceState)
    performanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-performance-mode', 'data-task-busy']
    })
    syncPerformanceState()

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
      performanceObserver.disconnect()
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
