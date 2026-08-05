import { useState } from 'react'
import './assets/main.css'

type Plan = Awaited<ReturnType<typeof window.api.scanPlan>>

function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState<string>('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(false)
  const chooseWorkspace = async (): Promise<void> => {
    const selected = await window.api.selectWorkspace()
    if (selected) {
      setWorkspace(selected)
      setPlan(null)
    }
  }
  const scan = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    try {
      setPlan(await window.api.scanPlan(workspace))
    } finally {
      setLoading(false)
    }
  }
  return (
    <main className="workspace-app">
      <header>
        <div>
          <p className="eyebrow">MEDIA SCRAPER</p>
          <h1>工作区扫描预览</h1>
          <p className="muted">本轮只生成计划，不会删除、移动或改名文件。</p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={chooseWorkspace}>
            选择工作区
          </button>
          <button disabled={!workspace || loading} onClick={scan}>
            {loading ? '扫描中…' : '生成清理计划'}
          </button>
        </div>
      </header>
      <section className="path-card">
        <span>当前工作区</span>
        <strong>{workspace || '尚未选择目录'}</strong>
      </section>
      {!plan && (
        <section className="empty">
          <h2>准备扫描</h2>
          <p>选择一个目录后，系统会递归识别视频、图片和其他文件，并跳过隐藏文件/隐藏目录。</p>
        </section>
      )}
      {plan && (
        <>
          <section className="stats">
            {Object.entries(plan.summary).map(([key, value]) => (
              <div key={key}>
                <span>{key}</span>
                <b>{value}</b>
              </div>
            ))}
          </section>
          <section className="grid">
            <PlanList title="保留项" items={plan.keep} tone="keep" />
            <PlanList title="永久删除候选（仅预览）" items={plan.deleteItems} tone="delete" />
            <PlanList
              title="上移预览"
              items={plan.moves.map((item) => ({
                relativePath: `${item.from} → ${item.to}`,
                kind: 'move'
              }))}
              tone="move"
            />
          </section>
          {plan.conflicts.length > 0 && (
            <section className="warning">
              <h2>需人工处理的图片歧义</h2>
              {plan.conflicts.map((item) => (
                <p key={item.image}>
                  {item.image} 同时匹配：{item.videos.join('、')}。按冻结规则，该图将不保留。
                </p>
              ))}
            </section>
          )}
          {plan.skippedHidden.length > 0 && (
            <p className="muted">已跳过 {plan.skippedHidden.length} 个隐藏项，不参与任何处理。</p>
          )}
        </>
      )}
    </main>
  )
}
function PlanList({
  title,
  items,
  tone
}: {
  title: string
  items: { relativePath: string; kind: string; reason?: string; posterFor?: string }[]
  tone: string
}): React.JSX.Element {
  return (
    <section className={`plan ${tone}`}>
      <h2>
        {title}
        <small>{items.length}</small>
      </h2>
      <div>
        {items.length ? (
          items.slice(0, 80).map((item) => (
            <article key={item.relativePath}>
              <b>{item.relativePath}</b>
              <span>
                {item.posterFor ? `poster → ${item.posterFor}` : item.reason || item.kind}
              </span>
            </article>
          ))
        ) : (
          <p>无项目</p>
        )}
      </div>
    </section>
  )
}
export default App
