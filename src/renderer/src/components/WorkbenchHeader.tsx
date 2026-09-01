import { usePalette } from '../hooks/usePalette'

type WorkbenchHeaderProps = {
  eyebrow: string
  title: string
  description: string
  actions?: React.ReactNode
  children?: React.ReactNode
  /** 页面未激活时整体向辅助技术隐藏（如 DedupePage 的共存页策略） */
  ariaHidden?: boolean
}

/**
 * 统一工作台页头：固定任务语境、主操作与附加工具的视觉层级。
 * 不同皮肤使用完全不同的组件结构（见各分支），其余皮肤保持原 DOM。
 * - terminal：顶部 mono 状态行 + 巨型标题 + 斜纹条 + 连排平行四边形动作条
 * - comic（漫画风）：网点底 + 倾斜手绘对话框铭牌 + 星爆破折装饰
 * - comic-ukiyo（浮世绘卷）：衬线标题 + 波文分隔线 + 标题旁方形朱印
 */
function WorkbenchHeader({
  eyebrow,
  title,
  description,
  actions,
  children,
  ariaHidden = false
}: WorkbenchHeaderProps): React.JSX.Element {
  const palette = usePalette()
  const a11y = ariaHidden ? { 'aria-hidden': true } : {}

  if (palette === 'terminal') {
    return (
      <header className="page-header workbench-header terminal-header" {...a11y}>
        <div className="th-top" aria-hidden="true">
          <span className="th-eyebrow">
            <i>▍</i>
            {eyebrow}
          </span>
          <span className="th-status">MEDIA SCRAPER // LOCAL OPS</span>
        </div>
        <div className="th-main">
          <h1>{title}</h1>
          <span className="th-slash" aria-hidden="true" />
        </div>
        <p className="muted th-desc">{description}</p>
        {children}
        {actions && <div className="actions page-actions th-actions">{actions}</div>}
      </header>
    )
  }

  if (palette === 'comic') {
    return (
      <header className="page-header workbench-header comic-header" {...a11y}>
        <span className="ch-burst" aria-hidden="true">
          漫
        </span>
        <div className="ch-plate">
          <p className="ch-eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="muted ch-desc">{description}</p>
          {children}
        </div>
        {actions && <div className="actions page-actions ch-actions">{actions}</div>}
      </header>
    )
  }

  if (palette === 'comic-ukiyo') {
    return (
      <header className="page-header workbench-header ukiyo-header" {...a11y}>
        <div className="uh-body">
          <p className="uh-eyebrow">{eyebrow}</p>
          <div className="uh-title-row">
            <h1>{title}</h1>
            <span className="uh-seal" aria-hidden="true">
              印
            </span>
          </div>
          <p className="muted uh-desc">{description}</p>
          {children}
        </div>
        {actions && <div className="actions page-actions uh-actions">{actions}</div>}
      </header>
    )
  }

  return (
    <header className="page-header workbench-header" {...a11y}>
      <div className="workbench-header-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
        {children}
      </div>
      {actions && <div className="actions page-actions workbench-header-actions">{actions}</div>}
    </header>
  )
}

export default WorkbenchHeader
