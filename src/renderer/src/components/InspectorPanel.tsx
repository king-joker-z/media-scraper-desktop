function InspectorPanel({
  label,
  title,
  children,
  className = ''
}: {
  label: string
  title?: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <aside className={`workbench-inspector ${className}`.trim()} aria-live="polite">
      <p className="eyebrow">{label}</p>
      {title && <h2>{title}</h2>}
      <div className="workbench-inspector-content">{children}</div>
    </aside>
  )
}

export default InspectorPanel
