function PlaceholderPage({
  icon,
  title,
  milestone,
  points
}: {
  icon: string
  title: string
  milestone: string
  points: string[]
}): React.JSX.Element {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">{milestone} 里程碑</p>
          <h1>{title}</h1>
          <p className="muted">该模块正在开发中，以下为已冻结的能力清单。</p>
        </div>
      </header>
      <section className="placeholder-card">
        <div className="placeholder-icon">{icon}</div>
        <ul>
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <p className="muted">按 docs/实现方案.md 排期交付，规则以 docs/需求冻结稿.md 为准。</p>
      </section>
    </div>
  )
}

export default PlaceholderPage
