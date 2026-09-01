import { useId } from 'react'

import { usePalette } from '../hooks/usePalette'

/**
 * 工作台空状态占位：默认皮肤保持原结构；
 * terminal（作战终端）：mono STANDBY 眉标 + 冰蓝虚线框；
 * comic（漫画风）：倾斜墨框提示牌 + 红点引导；
 * comic-ukiyo（浮世绘卷）：和纸双框 + 波纹分隔。
 */
function WorkbenchEmptyState({
  title,
  description,
  action
}: {
  title: string
  description: string
  action?: React.ReactNode
}): React.JSX.Element {
  const titleId = useId()
  const palette = usePalette()

  if (palette === 'terminal') {
    return (
      <section className="empty workbench-empty terminal-empty" aria-labelledby={titleId}>
        <i className="we-tag" aria-hidden="true">
          {'// STANDBY'}
        </i>
        <h2 id={titleId}>{title}</h2>
        <p>{description}</p>
        {action && <div className="workbench-empty-action">{action}</div>}
      </section>
    )
  }

  if (palette === 'comic') {
    return (
      <section className="empty workbench-empty comic-empty" aria-labelledby={titleId}>
        <span className="we-burst" aria-hidden="true">
          !
        </span>
        <h2 id={titleId}>{title}</h2>
        <p>{description}</p>
        {action && <div className="workbench-empty-action">{action}</div>}
      </section>
    )
  }

  if (palette === 'comic-ukiyo') {
    return (
      <section className="empty workbench-empty ukiyo-empty" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        <u className="we-wave" aria-hidden="true" />
        <p>{description}</p>
        {action && <div className="workbench-empty-action">{action}</div>}
      </section>
    )
  }

  return (
    <section className="empty workbench-empty" aria-labelledby={titleId}>
      <span className="workbench-empty-mark" aria-hidden="true" />
      <h2 id={titleId}>{title}</h2>
      <p>{description}</p>
      {action && <div className="workbench-empty-action">{action}</div>}
    </section>
  )
}

export default WorkbenchEmptyState
