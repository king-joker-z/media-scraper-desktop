import { motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react'
import { useRef } from 'react'

/**
 * 磁吸悬停（参考 Codrops Magnetic Buttons）：指针进入元素附近时，
 * 元素轻微跟随指针位移，离开后弹簧回弹。位移上限很小（默认 6px），
 * 只营造「被吸附」的物理手感，不干扰点击命中。
 */
function Magnetic({
  children,
  strength = 0.22,
  className
}: {
  children: React.ReactNode
  /** 0-1，位移 = 指针到中心偏移 × strength */
  strength?: number
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const springX = useSpring(x, { stiffness: 180, damping: 15, mass: 0.4 })
  const springY = useSpring(y, { stiffness: 180, damping: 15, mass: 0.4 })

  const onPointerMove = (event: React.PointerEvent): void => {
    if (reduceMotion || event.pointerType !== 'mouse') return
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    x.set((event.clientX - (rect.left + rect.width / 2)) * strength)
    y.set((event.clientY - (rect.top + rect.height / 2)) * strength)
  }

  const onPointerLeave = (): void => {
    x.set(0)
    y.set(0)
  }

  return (
    <motion.div
      ref={ref}
      className={className}
      style={{ x: springX, y: springY }}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </motion.div>
  )
}

export default Magnetic
