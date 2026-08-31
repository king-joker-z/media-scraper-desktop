import { useId } from 'react'

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
