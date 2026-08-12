import { useEffect, useMemo, useState } from 'react'
import type { CleanReport, PosterPicks, ScanPlan } from '../../../shared/types'
import ConfirmDialog from '../components/ConfirmDialog'
import ErrorBanner from '../components/ErrorBanner'
import { formatBytes } from '../utils/format'
import { useWorkspaceSync } from '../utils/useWorkspaceSync'

const SUMMARY_LABELS: Record<string, string> = {
  videos: '视频',
  images: '图片',
  otherFiles: '其他文件',
  keep: '保留',
  permanentDelete: '待删除',
  pendingPick: '待人工选图',
  hiddenSkipped: '隐藏跳过',
  conflicts: '冲突'
}

function CleanPage({
  active,
  workspace,
  onChooseWorkspace
}: {
  active: boolean
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [plan, setPlan] = useState<ScanPlan | null>(null)
  const [picks, setPicks] = useState<PosterPicks>({})
  const [loading, setLoading] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [report, setReport] = useState<CleanReport | null>(null)
  const [error, setError] = useState('')
  // 删除方式（回收站/永久删除），仅用于文案提示
  const [toTrash, setToTrash] = useState(true)

  useEffect(() => {
    window.api
      .getSettings()
      .then((settings) => setToTrash(settings.deleteToTrash))
      .catch(() => {})
  }, [])

  const scan = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    setError('')
    setReport(null)
    try {
      const next = await window.api.scanPlan(workspace)
      setPlan(next)
      // pendingPick 默认选中第一个候选，用户可改
      const defaults: PosterPicks = {}
      for (const pending of next.pendingPick) defaults[pending.video] = pending.candidates[0]
      setPicks(defaults)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // 页面可见时对比工作区指纹：有变化自动重扫，无变化保留现状
  useWorkspaceSync(workspace, active, scan)

  const choose = async (): Promise<void> => {
    setPlan(null)
    setReport(null)
    await onChooseWorkspace()
  }

  const picksComplete = useMemo(
    () => plan?.pendingPick.every((pending) => picks[pending.video]) ?? true,
    [plan, picks]
  )

  const execute = async (): Promise<void> => {
    if (!plan) return
    setConfirming(false)
    setExecuting(true)
    setError('')
    try {
      const result = await window.api.executeClean(plan, picks)
      setReport(result)
      if (!result.cancelled) setPlan(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExecuting(false)
    }
  }

  const cancel = async (): Promise<void> => {
    await window.api.cancelClean()
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">模块一 · 目录清理</p>
          <h1>工作区清理</h1>
          <p className="muted">
            扫描 → 预览 → 确认 → 执行 → 报告。
            {toTrash
              ? '删除默认移入系统回收站（可恢复，可在设置改为永久删除）。'
              : '当前为永久删除模式，执行前请仔细核对清单。'}
          </p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={choose} disabled={executing}>
            选择工作区
          </button>
          <button disabled={!workspace || loading || executing} onClick={scan}>
            {loading ? '扫描中…' : '生成清理计划'}
          </button>
          {plan && (
            <button
              className="danger-button"
              disabled={!picksComplete || executing}
              onClick={() => setConfirming(true)}
            >
              {executing ? '执行中…' : '执行清理'}
            </button>
          )}
          {executing && (
            <button className="secondary" onClick={cancel}>
              取消
            </button>
          )}
        </div>
      </header>

      <section className="path-card">
        <span>当前工作区</span>
        <strong>{workspace || '尚未选择目录'}</strong>
      </section>

      {error && <ErrorBanner message={error} />}

      {report && <ReportView report={report} onRescan={scan} />}

      {!plan && !report && !error && (
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
                <span>{SUMMARY_LABELS[key] ?? key}</span>
                <b>{value}</b>
              </div>
            ))}
            <div>
              <span>删除体积</span>
              <b>{formatBytes(plan.deleteBytes)}</b>
            </div>
          </section>

          {plan.pendingPick.length > 0 && (
            <section className="pick-card">
              <h2>为以下视频选择唯一 poster（其余候选将被永久删除）</h2>
              {plan.pendingPick.map((pending) => (
                <div key={pending.video} className="pick-row">
                  <b>{pending.video}</b>
                  <div className="pick-options">
                    {pending.candidates.map((candidate) => (
                      <label key={candidate}>
                        <input
                          type="radio"
                          name={pending.video}
                          checked={picks[pending.video] === candidate}
                          onChange={() =>
                            setPicks((prev) => ({ ...prev, [pending.video]: candidate }))
                          }
                        />
                        {candidate}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}

          <section className="grid">
            <PlanList title="保留项" items={plan.keep} tone="keep" />
            <PlanList
              title={toTrash ? '删除候选（进回收站）' : '永久删除候选'}
              items={plan.deleteItems}
              tone="delete"
            />
            <PlanList
              title="上移预览"
              items={plan.moves.map((item) => ({
                relativePath: `${item.from} → ${item.to}`,
                kind: 'move',
                reason: item.renamed ? '重名，自动追加序号' : undefined
              }))}
              tone="move"
            />
          </section>

          {plan.conflicts.length > 0 && (
            <section className="warning">
              <h2>图片歧义（一图多视频）</h2>
              {plan.conflicts.map((item) =>
                item.type === 'image-multi-video' ? (
                  <p key={item.image}>
                    {item.image} 同时匹配：{item.videos.join('、')}。按冻结规则，该图将不保留。
                  </p>
                ) : (
                  <p key={item.video}>
                    {item.video} 有多张候选图：{item.images.join('、')}，请在上方选择。
                  </p>
                )
              )}
            </section>
          )}
          {plan.skippedHidden.length > 0 && (
            <p className="muted">已跳过 {plan.skippedHidden.length} 个隐藏项，不参与任何处理。</p>
          )}
        </>
      )}

      {confirming && plan && (
        <ConfirmDialog
          title="确认执行清理计划"
          deleteCount={plan.deleteItems.length + unpickedCount(plan, picks)}
          deleteBytes={plan.deleteBytes}
          danger={false}
          recoverable={toTrash}
          extra={`同时将上移 ${plan.moves.length} 个文件到工作区根目录，并把保留 poster 标准化为「视频名-poster.jpg」。`}
          onConfirm={execute}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

function unpickedCount(plan: ScanPlan, picks: PosterPicks): number {
  return plan.pendingPick.reduce(
    (sum, pending) => sum + pending.candidates.filter((c) => c !== picks[pending.video]).length,
    0
  )
}

function ReportView({
  report,
  onRescan
}: {
  report: CleanReport
  onRescan: () => Promise<void>
}): React.JSX.Element {
  return (
    <section className={`report-card ${report.cancelled ? 'cancelled' : ''}`}>
      <h2>{report.cancelled ? '已取消（以下为已完成部分）' : '执行报告'}</h2>
      <div className="report-grid">
        <div>
          <span>删除</span>
          <b>
            {report.deletedCount} 个 / {formatBytes(report.deletedBytes)}
          </b>
        </div>
        <div>
          <span>转 JPG</span>
          <b>{report.converted.length}</b>
        </div>
        <div>
          <span>改名</span>
          <b>{report.renamed.length}</b>
        </div>
        <div>
          <span>上移</span>
          <b>{report.moved.length}</b>
        </div>
        <div>
          <span>删除空目录</span>
          <b>{report.removedDirs.length}</b>
        </div>
        <div>
          <span>失败</span>
          <b className={report.failed.length ? 'danger-text' : ''}>{report.failed.length}</b>
        </div>
        <div>
          <span>耗时</span>
          <b>{(report.durationMs / 1000).toFixed(1)}s</b>
        </div>
      </div>
      {report.failed.length > 0 && (
        <div className="report-failed">
          {report.failed.slice(0, 20).map((item) => (
            <p key={item.target}>
              {item.target}：{item.error}
            </p>
          ))}
          {report.failed.length > 20 && (
            <p className="muted">仅显示前 20 条，共 {report.failed.length} 条失败记录</p>
          )}
        </div>
      )}
      <div className="actions">
        <button className="secondary" onClick={onRescan}>
          重新扫描
        </button>
      </div>
    </section>
  )
}

// 清单默认只渲染前 80 条防大目录卡顿；截断时明示总数并可展开（原先静默截断）
const PLAN_LIST_PREVIEW = 80

function PlanList({
  title,
  items,
  tone
}: {
  title: string
  items: { relativePath: string; kind: string; reason?: string; posterFor?: string }[]
  tone: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? items : items.slice(0, PLAN_LIST_PREVIEW)
  return (
    <section className={`plan ${tone}`}>
      <h2>
        {title}
        <small>{items.length}</small>
      </h2>
      <div>
        {items.length ? (
          <>
            {visible.map((item) => (
              <article key={item.relativePath}>
                <b>{item.relativePath}</b>
                <span>
                  {item.posterFor ? `poster → ${item.posterFor}` : item.reason || item.kind}
                </span>
              </article>
            ))}
            {items.length > PLAN_LIST_PREVIEW && (
              <button className="secondary" onClick={() => setExpanded((value) => !value)}>
                {expanded
                  ? '收起'
                  : `显示全部 ${items.length} 条（当前仅前 ${PLAN_LIST_PREVIEW} 条）`}
              </button>
            )}
          </>
        ) : (
          <p>无项目</p>
        )}
      </div>
    </section>
  )
}

export default CleanPage
