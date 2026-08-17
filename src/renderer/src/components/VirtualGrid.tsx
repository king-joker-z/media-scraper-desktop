import { useEffect, useRef, useState } from 'react'

interface VirtualGridProps<T> {
  items: T[]
  /** 卡片最小宽度（决定列数），默认 210 */
  minItemWidth?: number
  /** 卡片间距，默认 14 */
  gap?: number
  /** 卡片文字区高度（缩略图之外的固定部分），默认 58 */
  metaHeight?: number
  /** 缩略图宽高比，默认 16 / 9 */
  thumbnailRatio?: number
  /** 视口上下额外渲染的行数，默认 3 */
  overscan?: number
  className?: string
  /** 可视窗口变化时回传已渲染项，供页面按可见范围发起轻量操作。 */
  onVisibleItemsChange?: (items: T[]) => void
  renderItem: (item: T, style: React.CSSProperties, index: number) => React.ReactNode
}

/**
 * 网格虚拟化：只渲染可视窗口（±overscan 行）内的卡片，万级列表不掉帧。
 * 依赖 .page-host 作为滚动容器（页面常驻挂载结构），卡片为 16:9 缩略图 + 固定文字区。
 */
function VirtualGrid<T>({
  items,
  minItemWidth = 210,
  gap = 14,
  metaHeight = 58,
  thumbnailRatio = 16 / 9,
  overscan = 3,
  className,
  onVisibleItemsChange,
  renderItem
}: VirtualGridProps<T>): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [range, setRange] = useState({ start: 0, end: 8 })

  // 容器宽度跟随布局（页面隐藏时 clientWidth 为 0，重新可见时 ResizeObserver 恢复）
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  const columns = Math.max(1, Math.floor((width + gap) / (minItemWidth + gap)))
  const colWidth = width > 0 ? (width - gap * (columns - 1)) / columns : minItemWidth
  const rowHeight = Math.round(colWidth / thumbnailRatio + metaHeight)
  const rows = Math.ceil(items.length / columns)

  // 监听页面滚动容器，计算可见行窗口（rAF 节流）
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const scroller = el.closest('.page-host')
    if (!(scroller instanceof HTMLElement)) return
    let raf = 0
    const update = (): void => {
      raf = 0
      const scRect = scroller.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      // 网格相对滚动内容顶部的偏移
      const offsetTop = elRect.top - scRect.top + scroller.scrollTop
      const stride = rowHeight + gap
      const startRow = Math.max(0, Math.floor((scroller.scrollTop - offsetTop) / stride) - overscan)
      const endRow = Math.min(
        rows,
        Math.ceil((scroller.scrollTop + scroller.clientHeight - offsetTop) / stride) + overscan
      )
      setRange((prev) =>
        prev.start === startRow && prev.end === endRow ? prev : { start: startRow, end: endRow }
      )
    }
    const onScroll = (): void => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [rowHeight, rows, gap, overscan])

  useEffect(() => {
    onVisibleItemsChange?.(
      items.slice(range.start * columns, Math.min(items.length, range.end * columns))
    )
  }, [columns, items, onVisibleItemsChange, range.end, range.start])

  const cells: { item: T; index: number; left: number; top: number }[] = []
  for (let row = range.start; row < range.end; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const index = row * columns + col
      if (index >= items.length) break
      cells.push({
        item: items[index],
        index,
        left: col * (colWidth + gap),
        top: row * (rowHeight + gap)
      })
    }
  }

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ position: 'relative', height: rows > 0 ? rows * (rowHeight + gap) - gap : 0 }}
    >
      {cells.map(({ item, index, left, top }) =>
        renderItem(
          item,
          { position: 'absolute', left, top, width: colWidth, height: rowHeight },
          index
        )
      )}
    </div>
  )
}

export default VirtualGrid
