import { usePalette } from '../hooks/usePalette'

export type StatGridItem = {
  label: string
  value: React.ReactNode
  /** 提供时渲染为可交互格子（默认皮肤渲染为 library-stat-action 按钮） */
  onSelect?: () => void
  active?: boolean
  valueClassName?: string
}

type StatGridProps = {
  items: StatGridItem[]
  className?: string
  ariaLabel?: string
}

/**
 * 统计读数条：默认皮肤渲染与原先各页面手写的 .stats 结构完全一致
 *（div/span/b，可交互项为 library-stat-action 按钮），零视觉变化；
 * 其余皮肤渲染各自完全不同的 DOM：
 * - terminal（作战终端）：读数板 —— 序号 + 大号等宽数字 + 微型刻度条
 * - comic（漫画风）：分格白卡 —— 粗黑边框 + 硬投影 + 对话泡胶囊标签 + 网点条
 * - comic-ukiyo（浮世绘卷）：和纸印屏 —— 靛蓝双框 + 朱印点数 + 衬线数字
 */
function StatGrid({ items, className, ariaLabel }: StatGridProps): React.JSX.Element {
  const palette = usePalette()

  if (palette === 'terminal') {
    return (
      <section className={`stats terminal-statboard ${className ?? ''}`} aria-label={ariaLabel}>
        {items.map((item, index) => {
          const inner = (
            <>
              <i className="tsb-index" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </i>
              <b className={item.valueClassName}>{item.value}</b>
              <span className="tsb-label">{item.label}</span>
              <u className="tsb-bar" aria-hidden="true" />
            </>
          )
          return item.onSelect ? (
            <button
              key={item.label}
              className={`tsb-cell selectable ${item.active ? 'active' : ''}`}
              onClick={item.onSelect}
            >
              {inner}
            </button>
          ) : (
            <div key={item.label} className="tsb-cell">
              {inner}
            </div>
          )
        })}
      </section>
    )
  }

  if (palette === 'comic') {
    return (
      <section className={`stats comic-statboard ${className ?? ''}`} aria-label={ariaLabel}>
        {items.map((item) => {
          const inner = (
            <>
              <span className="csb-label">{item.label}</span>
              <b className={item.valueClassName}>{item.value}</b>
              <u className="csb-bar" aria-hidden="true" />
            </>
          )
          return item.onSelect ? (
            <button
              key={item.label}
              className={`csb-cell selectable ${item.active ? 'active' : ''}`}
              onClick={item.onSelect}
            >
              {inner}
            </button>
          ) : (
            <div key={item.label} className="csb-cell">
              {inner}
            </div>
          )
        })}
      </section>
    )
  }

  if (palette === 'comic-ukiyo') {
    return (
      <section className={`stats ukiyo-statboard ${className ?? ''}`} aria-label={ariaLabel}>
        {items.map((item) => {
          const inner = (
            <>
              <span className="usb-label">{item.label}</span>
              <b className={item.valueClassName}>{item.value}</b>
              <u className="usb-jijitsu" aria-hidden="true" />
            </>
          )
          return item.onSelect ? (
            <button
              key={item.label}
              className={`usb-cell selectable ${item.active ? 'active' : ''}`}
              onClick={item.onSelect}
            >
              {inner}
            </button>
          ) : (
            <div key={item.label} className="usb-cell">
              {inner}
            </div>
          )
        })}
      </section>
    )
  }

  return (
    <section className={`stats ${className ?? ''}`} aria-label={ariaLabel}>
      {items.map((item) =>
        item.onSelect ? (
          <button
            key={item.label}
            className={`library-stat-action ${item.active ? 'active' : ''}`}
            onClick={item.onSelect}
          >
            <span>{item.label}</span>
            <b className={item.valueClassName}>{item.value}</b>
          </button>
        ) : (
          <div key={item.label}>
            <span>{item.label}</span>
            <b className={item.valueClassName}>{item.value}</b>
          </div>
        )
      )}
    </section>
  )
}

export default StatGrid
