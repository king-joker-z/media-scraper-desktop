import { useMemo, useState } from 'react'
import type { MergeMode, MergeResult, MergeVideoItem } from '../../../shared/types'
import {
  checkCompatibility,
  estimateOutputBytes,
  mergeOutputName
} from '../../../shared/merge-rules.mjs'
import ConfirmDialog from '../components/ConfirmDialog'
import MergeSortableList from '../components/MergeSortableList'
import { formatBytes } from '../utils/format'

const MODE_TABS: { key: MergeMode; label: string }[] = [
  { key: 'all', label: '全合并' },
  { key: 'landscape', label: '横屏合并' },
  { key: 'portrait', label: '竖屏合并' }
]

function MergePage({
  workspace,
  onChooseWorkspace
}: {
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [videos, setVideos] = useState<MergeVideoItem[]>([])
  const [freeBytes, setFreeBytes] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<MergeMode>('all')
  const [order, setOrder] = useState<string[]>([])
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [merging, setMerging] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // 源删除时是否连同 poster 一起删除（默认保留封面图，归档场景不被破坏）
  const [includePosters, setIncludePosters] = useState(false)
  const [result, setResult] = useState<MergeResult | null>(null)
  const [deleteNote, setDeleteNote] = useState('')
  const [error, setError] = useState('')

  const scan = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    setError('')
    setResult(null)
    setDeleteNote('')
    try {
      const data = await window.api.scanMergeVideos(workspace)
      setVideos(data.videos)
      setFreeBytes(data.freeBytes)
      setLoaded(true)
      setOrder([])
      setExcluded(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  /** 当前模式的全部片段（含被置灰排除的，按用户顺序展示） */
  const rows = useMemo((): MergeVideoItem[] => {
    const byRel = new Map(videos.map((v) => [v.relativePath, v]))
    let pool: MergeVideoItem[] = videos
    if (mode === 'landscape') pool = videos.filter((v) => v.media?.orientation === 'landscape')
    else if (mode === 'portrait') pool = videos.filter((v) => v.media?.orientation === 'portrait')

    const poolRels = new Set(pool.map((v) => v.relativePath))
    const ordered = order.filter((rel) => poolRels.has(rel))
    const remaining = pool
      .filter((v) => !ordered.includes(v.relativePath))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    return [...ordered.map((rel) => byRel.get(rel)!), ...remaining]
  }, [videos, mode, order])

  /** 实际参与合并的片段（排除置灰项） */
  const items = useMemo(
    () => rows.filter((item) => !excluded.has(item.relativePath)),
    [rows, excluded]
  )

  const compatibility = useMemo(() => checkCompatibility(items), [items])
  const workspaceName = workspace.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
  const outputName = mergeOutputName(workspaceName, mode)
  const estimated = useMemo(
    () => estimateOutputBytes(items, compatibility.compatible),
    [items, compatibility]
  )
  const totalDurationMs = items.reduce((sum, item) => sum + (item.media?.durationMs ?? 0), 0)
  const notEnoughSpace = freeBytes > 0 && estimated > freeBytes

  const execute = async (): Promise<void> => {
    if (!workspace) return
    setConfirming(false)
    setMerging(true)
    setError('')
    setResult(null)
    setDeleteNote('')
    try {
      const merged = await window.api.executeMerge(workspace, items, outputName)
      setResult(merged)
      // 校验通过 → 自动弹出源片段删除确认（冻结稿 §4：单独展示与确认）
      if (merged.verified && !merged.cancelled) setConfirmingDelete(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMerging(false)
    }
  }

  const deleteSources = async (): Promise<void> => {
    if (!workspace) return
    setConfirmingDelete(false)
    setError('')
    try {
      const report = await window.api.deleteMergeSources(
        workspace,
        items.map((item) => ({
          videoRel: item.relativePath,
          posterRel: includePosters ? item.posterRelativePath : null
        }))
      )
      setDeleteNote(
        `已永久删除 ${report.deletedCount} 个源文件` +
          (includePosters ? '（含关联 poster）' : '（poster 已保留）') +
          (report.failed.length ? `，失败 ${report.failed.length} 个` : '')
      )
      await scan()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const toggleExclude = (rel: string): void => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">模块二 · 视频合并</p>
          <h1>视频物理合并</h1>
          <p className="muted">兼容素材无重编码秒级拼接；不兼容自动转码统一参数后合并。</p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onChooseWorkspace} disabled={merging}>
            选择工作区
          </button>
          <button className="secondary" onClick={scan} disabled={!workspace || loading || merging}>
            {loading ? '读取中…' : '扫描视频'}
          </button>
          {items.length >= 2 && !result && (
            <button disabled={merging || notEnoughSpace} onClick={() => setConfirming(true)}>
              {merging ? '合并中…' : `执行合并（${items.length} 段）`}
            </button>
          )}
          {merging && (
            <button className="secondary" onClick={() => window.api.cancelMerge()}>
              取消
            </button>
          )}
        </div>
      </header>

      <section className="path-card">
        <span>当前工作区</span>
        <strong>{workspace || '尚未选择目录'}</strong>
      </section>

      {error && <section className="error-banner">{error}</section>}
      {deleteNote && <section className="notice-banner">{deleteNote}</section>}

      {loaded && videos.length > 0 && (
        <>
          <div className="mode-tabs">
            {MODE_TABS.map((tab) => (
              <button
                key={tab.key}
                className={`mode-tab ${mode === tab.key ? 'active' : ''}`}
                onClick={() => setMode(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {items.length > 0 && (
            <section className="settings-card">
              <h2>合并计划</h2>
              <div className="merge-plan">
                <span>输出：{outputName}</span>
                <span>
                  片段：{items.length} 段 · 总时长 {(totalDurationMs / 60000).toFixed(1)} 分钟
                </span>
                <span>
                  {compatibility.compatible ? (
                    <b className="ok-text">✅ 参数一致，无重编码拼接（快、无损）</b>
                  ) : (
                    <b className="danger-text">⚠️ 参数不一致，将转码统一后合并</b>
                  )}
                </span>
                <span>
                  预计输出 {formatBytes(estimated)} · 磁盘可用 {formatBytes(freeBytes)}
                  {notEnoughSpace && <b className="danger-text">（空间不足！）</b>}
                </span>
                {!compatibility.compatible && (
                  <details>
                    <summary className="muted">
                      查看 {compatibility.reasons.length} 处参数差异
                    </summary>
                    {compatibility.reasons.slice(0, 10).map((reason) => (
                      <p key={reason} className="muted">
                        {reason}
                      </p>
                    ))}
                  </details>
                )}
              </div>
            </section>
          )}

          <p className="muted">
            拖动 ⠿
            调整拼接顺序；点右侧「参与」可将单个视频置灰排除（不参与本次合并），再点恢复。当前参与{' '}
            {items.length} 段。
          </p>
          <MergeSortableList
            items={rows}
            excluded={excluded}
            onToggleExclude={toggleExclude}
            onReorder={(next) => setOrder(next.map((item) => item.relativePath))}
          />
        </>
      )}

      {loaded && videos.length === 0 && (
        <section className="empty">
          <h2>没有发现视频</h2>
        </section>
      )}
      {!loaded && (
        <section className="empty">
          <h2>扫描后开始</h2>
          <p>选择工作区并点击「扫描视频」，将读取每个视频的编码信息用于兼容性判定。</p>
        </section>
      )}

      {result && (
        <section className={`report-card ${result.verified ? '' : 'cancelled'}`}>
          <h2>{result.cancelled ? '已取消' : result.verified ? '合并完成' : '合并失败'}</h2>
          <p className="muted">
            {result.verifyNote}
            {result.transcoded && '（已转码统一参数）'}
          </p>
          {result.outputPath && (
            <p className="muted" style={{ userSelect: 'text' }}>
              输出：{result.outputPath}
            </p>
          )}
          {result.error && <p className="danger-text">{result.error}</p>}
          {result.verified && (
            <div className="actions">
              <button className="danger-button" onClick={() => setConfirmingDelete(true)}>
                删除源视频（{items.length} 个）
              </button>
              <button className="secondary" onClick={scan}>
                保留并刷新列表
              </button>
            </div>
          )}
        </section>
      )}

      {confirming && (
        <ConfirmDialog
          title="确认执行合并"
          deleteCount={0}
          deleteBytes={0}
          danger={false}
          extra={`将把 ${items.length} 段视频合并为 ${outputName}（${compatibility.compatible ? '无重编码拼接' : '转码统一后合并'}，预计 ${formatBytes(estimated)}）。源文件在合并校验通过后才会询问是否删除。`}
          onConfirm={execute}
          onCancel={() => setConfirming(false)}
        />
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title="删除源视频"
          deleteCount={
            items.length + (includePosters ? items.filter((i) => i.posterRelativePath).length : 0)
          }
          deleteBytes={items.reduce((sum, i) => sum + i.size, 0)}
          danger={items.length > 50}
          extra="合并输出已通过校验。默认只删除源视频并保留封面图（归档目录不受影响）；残留的 poster 可后续用「目录清理」处理。"
          toggle={{
            label: '同时删除关联 poster 封面图',
            checked: includePosters,
            onChange: setIncludePosters
          }}
          onConfirm={deleteSources}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  )
}

export default MergePage
