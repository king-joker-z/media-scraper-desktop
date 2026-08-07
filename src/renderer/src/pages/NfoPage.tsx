import { useMemo, useState } from 'react'
import type { NfoPlan, NfoReport } from '../../../shared/types'
import ConfirmDialog from '../components/ConfirmDialog'
import ErrorBanner from '../components/ErrorBanner'
import { useWorkspaceSync } from '../utils/useWorkspaceSync'

function NfoPage({
  active,
  workspace,
  onChooseWorkspace
}: {
  active: boolean
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [plan, setPlan] = useState<NfoPlan | null>(null)
  const [actorName, setActorName] = useState('')
  const [includeConflicts, setIncludeConflicts] = useState(false)
  const [loading, setLoading] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [report, setReport] = useState<NfoReport | null>(null)
  const [error, setError] = useState('')

  const scan = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    setError('')
    setReport(null)
    try {
      const next = await window.api.createNfoPlan(workspace)
      setPlan(next)
      setActorName((prev) => prev || next.actorDefault)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // 页面可见时对比工作区指纹：有变化自动重扫
  useWorkspaceSync(workspace, active, scan)

  const targets = useMemo(() => {
    if (!plan) return []
    return plan.items.filter((item) => includeConflicts || !item.conflict)
  }, [plan, includeConflicts])
  const conflictCount = plan?.items.filter((item) => item.conflict).length ?? 0

  const execute = async (): Promise<void> => {
    if (!workspace || !plan) return
    setConfirming(false)
    setExecuting(true)
    setError('')
    try {
      const result = await window.api.executeNfoArchive(workspace, targets, actorName.trim())
      setReport(result)
      if (!result.cancelled) setPlan(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExecuting(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">模块五 · NFO 归档</p>
          <h1>NFO 与独立归档</h1>
          <p className="muted">
            每个视频建立同名文件夹，移入视频与 poster，生成兼容 Kodi/Jellyfin/Emby 的 NFO。
          </p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onChooseWorkspace} disabled={executing}>
            选择工作区
          </button>
          <button
            className="secondary"
            onClick={scan}
            disabled={!workspace || loading || executing}
          >
            {loading ? '扫描中…' : '生成归档计划'}
          </button>
          {plan && targets.length > 0 && (
            <button disabled={executing || !actorName.trim()} onClick={() => setConfirming(true)}>
              {executing ? '执行中…' : `执行归档（${targets.length}）`}
            </button>
          )}
          {executing && (
            <button className="secondary" onClick={() => window.api.cancelNfo()}>
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

      {report && (
        <section className={`report-card ${report.cancelled ? 'cancelled' : ''}`}>
          <h2>{report.cancelled ? '已取消（以下为已完成部分）' : '归档报告'}</h2>
          <div className="report-grid">
            <div>
              <span>成功归档</span>
              <b>{report.archivedCount}</b>
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
            </div>
          )}
          <div className="actions">
            <button className="secondary" onClick={scan}>
              重新扫描
            </button>
          </div>
        </section>
      )}

      {plan && (
        <>
          <section className="settings-card">
            <label className="field">
              <span>演员名（actor.name / role，默认为工作区文件夹名）</span>
              <input value={actorName} onChange={(event) => setActorName(event.target.value)} />
            </label>
            {conflictCount > 0 && (
              <label className="confirm-check">
                <input
                  type="checkbox"
                  checked={includeConflicts}
                  onChange={(event) => setIncludeConflicts(event.target.checked)}
                />
                包含 {conflictCount} 个目标目录已存在且非空的冲突项（移入时重名自动加序号）
              </label>
            )}
          </section>

          <section className="rename-table">
            <div className="rename-row rename-head">
              <span>视频</span>
              <span>归档结构</span>
              <span>状态</span>
            </div>
            {targets.map((item) => (
              <div key={item.videoRel} className={`rename-row ${item.conflict ? 'invalid' : ''}`}>
                <span className="rename-old" title={item.videoRel}>
                  {item.videoRel}
                </span>
                <span
                  className="rename-new nfo-structure"
                  title={`${item.targetDir}/（视频${item.posterRel ? ' + poster' : ''} + nfo）`}
                >
                  <small>
                    {item.targetDir}/（视频{item.posterRel ? ' + poster' : ''} + nfo）
                  </small>
                </span>
                <span className="rename-status">
                  {item.conflict ? (
                    <b className="danger-text">目录已存在</b>
                  ) : (
                    <span className="muted">就绪</span>
                  )}
                </span>
              </div>
            ))}
          </section>
        </>
      )}

      {!plan && !report && (
        <section className="empty">
          <h2>扫描后开始</h2>
          <p>选择工作区并点击「生成归档计划」。归档不删除任何文件。</p>
        </section>
      )}

      {confirming && (
        <ConfirmDialog
          title="确认执行 NFO 归档"
          deleteCount={0}
          deleteBytes={0}
          danger={false}
          extra={`将把 ${targets.length} 个视频（含 poster）移入各自同名文件夹并生成 NFO，actor 为「${actorName}」。不删除任何文件。`}
          onConfirm={execute}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

export default NfoPage
