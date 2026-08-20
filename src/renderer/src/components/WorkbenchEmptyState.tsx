function WorkbenchEmptyState({
  title,
  description,
  action
}: {
  title: string
  description: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="empty workbench-empty" aria-labelledby="workbench-empty-title">
      <span className="workbench-empty-mark" aria-hidden="true" />
      <h2 id="workbench-empty-title">{title}</h2>
      <p>{description}</p>
      {action && <div className="workbench-empty-action">{action}</div>}
    </section>
  )
}

export default WorkbenchEmptyState
