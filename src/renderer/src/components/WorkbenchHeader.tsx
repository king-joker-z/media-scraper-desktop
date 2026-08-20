type WorkbenchHeaderProps = {
  eyebrow: string
  title: string
  description: string
  actions?: React.ReactNode
  children?: React.ReactNode
}

/** 统一工作台页头：固定任务语境、主操作与附加工具的视觉层级。 */
function WorkbenchHeader({
  eyebrow,
  title,
  description,
  actions,
  children
}: WorkbenchHeaderProps): React.JSX.Element {
  return (
    <header className="page-header workbench-header">
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
