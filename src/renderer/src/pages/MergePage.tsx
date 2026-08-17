import { useMemo, useRef, useState } from 'react'
import type { MergeMode, MergeResult, MergeVideoItem } from '../../../shared/types'
import {
  checkCompatibility,
  estimateOutputBytes,
  groupByOrientation,
  mergeOutputName
} from '../../../shared/merge-rules.mjs'
import ConfirmDialog from '../components/ConfirmDialog'
import ErrorBanner from '../components/ErrorBanner'
import MergeSortableList from '../components/MergeSortableList'
import VideoModal from '../components/VideoModal'
import { formatBytes } from '../utils/format'
import { useWorkspaceSync } from '../utils/useWorkspaceSync'

const MODE_TABS: { key: MergeMode; label: string }[] = [
  { key: 'all', label: '全合并' },
  { key: 'landscape', label: '横屏合并' },
  { key: 'portrait', label: '竖屏合并' },
  { key: 'separate', label: '横竖分别合并' }
]

function MergePage({
  active,
  workspace,
  onChooseWorkspace
}: {
  active: boolean
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [videos, setVideos] = useState<MergeVideoItem[]>([])
  const [freeBytes, setFreeBytes] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<MergeMode>('all')
  const [order, setOrder] = useState<string[]>([])
  const [orientationFirst, setOrientationFirst] = useState<'landscape' | 'portrait'>('landscape')
  const [sortBy, setSortBy] = useState<'manual' | 'name' | 'size'>('manual')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [merging, setMerging] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmingOrientationBatch, setConfirmingOrientationBatch] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // 源删除时是否连同 poster 一起删除（默认保留封面图，归档场景不被破坏）
  const [includePosters, setIncludePosters] = useState(false)
  const [result, setResult] = useState<MergeResult | null>(null)
  const [orientationBatchResults, setOrientationBatchResults] = useState<
    Array<{ mode: 'landscape' | 'portrait'; result: MergeResult }>
  >([])
  const [deleteNote, setDeleteNote] = useState('')
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState<MergeVideoItem | null>(null)
  const [gpuChecking, setGpuChecking] = useState(false)
  const [gpuStatus, setGpuStatus] = useState('')
  // 删除确认必须绑定产生合并结果的工作区，避免用户切换目录后误删同名相对路径。
  const deleteWorkspaceRef = useRef<string | null>(null)

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

  // 页面可见时对比工作区指纹：有变化自动重扫
  useWorkspaceSync(workspace, active, scan)

  /** 当前模式的全部片段（含被置灰排除的，按用户顺序展示） */
  const rows = useMemo((): MergeVideoItem[] => {
    const byRel = new Map(videos.map((v) => [v.relativePath, v]))
    let pool: MergeVideoItem[] = videos
    if (mode === 'landscape') pool = videos.filter((v) => v.media?.orientation === 'landscape')
    else if (mode === 'portrait') pool = videos.filter((v) => v.media?.orientation === 'portrait')

    const poolRels = new Set(pool.map((v) => v.relativePath))
    const ordered = order.filter((rel) => poolRels.has(rel))
    const current = [
      ...ordered.map((rel) => byRel.get(rel)!),
      ...pool.filter((v) => !ordered.includes(v.relativePath))
    ]
    if (sortBy === 'name') {
      return current.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    }
    if (sortBy === 'size')
      return current.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
    return current
  }, [videos, mode, order, sortBy])

  /** 实际参与合并的片段（排除置灰项） */
  const items = useMemo(
    () => rows.filter((item) => !excluded.has(item.relativePath)),
    [rows, excluded]
  )

  const orientationGroupedItems = useMemo(
    () => (mode === 'all' ? groupByOrientation(items, orientationFirst) : items),
    [items, mode, orientationFirst]
  )
  const orientationBatches = useMemo(
    () => ({
      landscape: rows.filter(
        (item) => !excluded.has(item.relativePath) && item.media?.orientation === 'landscape'
      ),
      portrait: rows.filter(
        (item) => !excluded.has(item.relativePath) && item.media?.orientation === 'portrait'
      )
    }),
    [rows, excluded]
  )
  const compatibility = useMemo(() => checkCompatibility(items), [items])
  const workspaceName = workspace.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
  const outputName = mergeOutputName(workspaceName, mode === 'separate' ? 'all' : mode)
  const estimated = useMemo(
    () => estimateOutputBytes(items, compatibility.compatible),
    [items, compatibility]
  )
  const totalDurationMs = useMemo(
    () => items.reduce((sum, item) => sum + (item.media?.durationMs ?? 0), 0),
    [items]
  )
  const notEnoughSpace = freeBytes > 0 && estimated > freeBytes
  const unreadableItems = useMemo(() => items.filter((item) => !item.media), [items])
  const cannotMerge = unreadableItems.length > 0

  /** 全合并时把可见列表实际重排为同方向连续，用户可立即确认横竖顺序已生效。 */
  const groupOrientations = (first: 'landscape' | 'portrait'): void => {
    setOrientationFirst(first)
    setOrder(groupByOrientation(rows, first).map((item) => item.relativePath))
    setSortBy('manual')
  }

  const applySort = (nextSort: 'manual' | 'name' | 'size'): void => {
    setSortBy(nextSort)
    if (nextSort !== 'manual') setOrder([])
  }

  const checkGpu = async (): Promise<void> => {
    setGpuChecking(true)
    setGpuStatus('正在运行 NVIDIA / CUDA 实测…')
    try {
      const capability = await window.api.getGpuCapability()
      setGpuStatus(
        `NVENC：${capability.nvenc.available ? '可用' : `不可用（${capability.nvenc.reason || '未知原因'}）`}；完整 GPU 流水线：${capability.cudaPipeline.available ? '可用' : `不可用（${capability.cudaPipeline.reason || '将自动降级'}）`}`
      )
    } catch (err) {
      setGpuStatus(`检测失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setGpuChecking(false)
    }
  }

  const execute = async (): Promise<void> => {
    if (!workspace) return
    setConfirming(false)
    deleteWorkspaceRef.current = null
    setMerging(true)
    setError('')
    setResult(null)
    setDeleteNote('')
    try {
      const merged = await window.api.executeMerge(workspace, orientationGroupedItems, outputName)
      setResult(merged)
      // 校验通过 → 自动弹出源片段删除确认（冻结稿 §4：单独展示与确认）
      if (merged.verified && !merged.cancelled) {
        deleteWorkspaceRef.current = workspace
        setConfirmingDelete(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMerging(false)
    }
  }

  const executeOrientationBatch = async (): Promise<void> => {
    if (!workspace) return
    setConfirmingOrientationBatch(false)
    deleteWorkspaceRef.current = null
    setMerging(true)
    setError('')
    setResult(null)
    setOrientationBatchResults([])
    setDeleteNote('')
    const plans = (['landscape', 'portrait'] as const)
      .map((batchMode) => ({ mode: batchMode, items: orientationBatches[batchMode] }))
      .filter((plan) => plan.items.length >= 2)
    const completed: Array<{ mode: 'landscape' | 'portrait'; result: MergeResult }> = []
    try {
      for (const plan of plans) {
        const merged = await window.api.executeMerge(
          workspace,
          plan.items,
          mergeOutputName(workspaceName, plan.mode)
        )
        completed.push({ mode: plan.mode, result: merged })
        setOrientationBatchResults([...completed])
        if (!merged.verified) break
      }
      if (completed.some(({ result: mergeResult }) => !mergeResult.verified)) {
        setError('横竖分别合并未全部完成，已保留成功输出和源视频；可单独重试失败方向。')
      } else if (completed.length === plans.length && completed.length > 0) {
        deleteWorkspaceRef.current = workspace
        setConfirmingDelete(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMerging(false)
    }
  }

  const deleteSources = async (): Promise<void> => {
    const deleteWorkspace = deleteWorkspaceRef.current
    if (!deleteWorkspace) return
    if (workspace !== deleteWorkspace) {
      setConfirmingDelete(false)
      setError('工作区已切换，为避免误删，已取消删除源视频确认。请回到原工作区后重新扫描。')
      return
    }
    setConfirmingDelete(false)
    setError('')
    try {
      const report = await window.api.deleteMergeSources(
        deleteWorkspace,
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
      deleteWorkspaceRef.current = null
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
          <button className="secondary" onClick={checkGpu} disabled={gpuChecking || merging}>
            {gpuChecking ? '检测 GPU 中…' : '检测 GPU 加速'}
          </button>
          <button
            className="secondary"
            onClick={onChooseWorkspace}
            disabled={merging || confirmingDelete}
          >
            选择工作区
          </button>
          <button className="secondary" onClick={scan} disabled={!workspace || loading || merging}>
            {loading ? '读取中…' : '扫描视频'}
          </button>
          {mode !== 'separate' &&
            items.length >= 2 &&
            !result &&
            orientationBatchResults.length === 0 && (
              <button
                disabled={merging || notEnoughSpace || cannotMerge}
                onClick={() => setConfirming(true)}
              >
                {merging ? '合并中…' : `执行合并（${items.length} 段）`}
              </button>
            )}
          {mode === 'separate' &&
            orientationBatches.landscape.length >= 2 &&
            orientationBatches.portrait.length >= 2 &&
            orientationBatchResults.length === 0 && (
              <button
                disabled={merging || cannotMerge}
                onClick={() => setConfirmingOrientationBatch(true)}
              >
                {merging ? '分别合并中…' : '执行横竖分别合并'}
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

      {error && <ErrorBanner message={error} />}
      {gpuStatus && <section className="notice-banner">GPU 状态：{gpuStatus}</section>}
      {deleteNote && <section className="notice-banner">{deleteNote}</section>}

      {loaded && videos.length > 0 && (
        <>
          <div className="mode-tabs">
            {MODE_TABS.filter(
              (tab) =>
                tab.key !== 'separate' ||
                (orientationBatches.landscape.length >= 2 &&
                  orientationBatches.portrait.length >= 2)
            ).map((tab) => (
              <button
                key={tab.key}
                className={`mode-tab ${mode === tab.key ? 'active' : ''}`}
                disabled={merging || Boolean(result) || orientationBatchResults.length > 0}
                onClick={() => setMode(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {mode === 'separate' && (
            <section className="notice-banner">
              <strong>横竖分别合并：</strong>
              将按当前排序分别生成横屏与竖屏两个文件；两项都校验通过后，会统一询问是否删除全部源视频。
              <div className="merge-plan">
                <span>
                  横屏：{orientationBatches.landscape.length} 段 →{' '}
                  {mergeOutputName(workspaceName, 'landscape')}
                </span>
                <span>
                  竖屏：{orientationBatches.portrait.length} 段 →{' '}
                  {mergeOutputName(workspaceName, 'portrait')}
                </span>
              </div>
            </section>
          )}

          {mode === 'all' && items.length > 1 && (
            <section className="notice-banner">
              <strong>横竖自动归类：</strong>
              全合并时按当前列表顺序保留同类内部排序，避免横竖片段交叉。
              <div className="actions">
                <button
                  className={`secondary ${orientationFirst === 'landscape' ? 'active' : ''}`}
                  onClick={() => groupOrientations('landscape')}
                >
                  横屏在前（{orientationBatches.landscape.length} 段）
                </button>
                <button
                  className={`secondary ${orientationFirst === 'portrait' ? 'active' : ''}`}
                  onClick={() => groupOrientations('portrait')}
                >
                  竖屏在前（{orientationBatches.portrait.length} 段）
                </button>
              </div>
            </section>
          )}

          {items.length > 0 && (
            <>
              <section className="settings-card">
                <h2>排序</h2>
                <div className="mode-tabs">
                  <button
                    className={`mode-tab ${sortBy === 'manual' ? 'active' : ''}`}
                    onClick={() => applySort('manual')}
                  >
                    手动拖拽
                  </button>
                  <button
                    className={`mode-tab ${sortBy === 'name' ? 'active' : ''}`}
                    onClick={() => applySort('name')}
                  >
                    按名称
                  </button>
                  <button
                    className={`mode-tab ${sortBy === 'size' ? 'active' : ''}`}
                    onClick={() => applySort('size')}
                  >
                    按大小（大到小）
                  </button>
                </div>
                {mode === 'all' && sortBy !== 'manual' && (
                  <p className="muted">
                    排序先在横屏、竖屏各自分类内生效，再按“
                    {orientationFirst === 'landscape' ? '横屏在前' : '竖屏在前'}”合并输出。
                  </p>
                )}
              </section>
              <section className="settings-card">
                <h2>合并计划</h2>
                <div className="merge-plan">
                  <span>输出：{outputName}</span>
                  <span>
                    片段：{items.length} 段 · 总时长 {(totalDurationMs / 60000).toFixed(1)} 分钟
                  </span>
                  <span>
                    {cannotMerge ? (
                      <b className="danger-text">⚠️ 存在无法读取媒体信息的片段，不能安全合并</b>
                    ) : compatibility.compatible ? (
                      <b className="ok-text">✅ 参数一致，无重编码拼接（快、无损）</b>
                    ) : (
                      <b className="danger-text">
                        ⚠️
                        参数不一致，将转码统一参数后合并；混合横竖屏时优先横屏画布，竖屏片段左右补黑边
                      </b>
                    )}
                  </span>
                  <span>
                    预计输出 {formatBytes(estimated)} · 磁盘可用 {formatBytes(freeBytes)}
                    {notEnoughSpace && <b className="danger-text">（空间不足！）</b>}
                  </span>
                  {!compatibility.compatible && !cannotMerge && (
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
            </>
          )}

          {cannotMerge && (
            <section className="warning" role="alert">
              <h3>请先排除无法读取的视频</h3>
              <p>以下片段无法读取媒体信息，已禁止合并，避免生成异常输出：</p>
              <p className="muted">{unreadableItems.map((item) => item.name).join('、')}</p>
            </section>
          )}
          <p className="muted">
            拖动 ⠿
            调整同类内拼接顺序；全合并会按上方横竖顺序自动归类。点右侧「参与」可将单个视频置灰排除，再点恢复。当前参与{' '}
            {items.length} 段。
          </p>
          <MergeSortableList
            items={rows}
            excluded={excluded}
            onToggleExclude={toggleExclude}
            onReorder={(next) => setOrder(next.map((item) => item.relativePath))}
            onPlay={setPlaying}
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

      {orientationBatchResults.length > 0 && (
        <section className="report-card">
          <h2>横竖分别合并结果</h2>
          <p className="muted">
            两个输出均校验通过后已弹出统一删源确认；若任一方向失败，源视频会完整保留。
          </p>
          {orientationBatchResults.map(({ mode: batchMode, result: mergeResult }) => (
            <p key={batchMode} className={mergeResult.verified ? 'ok-text' : 'danger-text'}>
              {batchMode === 'landscape' ? '横屏' : '竖屏'}：
              {mergeResult.verified ? '已完成' : '未完成'} · {mergeResult.verifyNote}
            </p>
          ))}
          <button className="secondary" onClick={scan} disabled={merging}>
            刷新列表
          </button>
        </section>
      )}

      {result && (
        <section className={`report-card ${result.verified ? '' : 'cancelled'}`}>
          <h2>{result.cancelled ? '已取消' : result.verified ? '合并完成' : '合并失败'}</h2>
          <p className="muted">
            {result.verifyNote}
            {result.transcoded && '（已转码统一参数）'}
          </p>
          {result.gpuSummary && (
            <section className="notice-banner">
              实际执行：{result.gpuSummary.note}；硬件处理 {result.gpuSummary.hardwareSegments} 段
              {result.gpuSummary.fallbackSegments > 0 &&
                `，安全降级 ${result.gpuSummary.fallbackSegments} 段`}
              {result.tempDirectory && `；临时目录：${result.tempDirectory}`}
            </section>
          )}
          {result.nvencFallbackReason && (
            <section className="warning merge-nvenc-fallback" role="alert">
              <h3>已自动回退 CPU 编码</h3>
              <p>
                你已开启 NVIDIA NVENC，但本次合并的能力检测未通过，因此没有使用 GPU，已改用 CPU x264
                完成转码。
              </p>
              <p className="muted" style={{ userSelect: 'text' }}>
                检测原因：{result.nvencFallbackReason}
              </p>
            </section>
          )}
          {result.outputPath && (
            <p className="muted" style={{ userSelect: 'text' }}>
              输出：{result.outputPath}
            </p>
          )}
          {result.error && <p className="danger-text">{result.error}</p>}
          <div className="actions">
            {result.verified ? (
              <>
                <button className="danger-button" onClick={() => setConfirmingDelete(true)}>
                  删除源视频（{items.length} 个）
                </button>
                <button className="secondary" onClick={scan}>
                  保留并刷新列表
                </button>
              </>
            ) : (
              <>
                <button
                  disabled={merging || notEnoughSpace || cannotMerge}
                  onClick={() => {
                    setResult(null)
                    setConfirming(true)
                  }}
                >
                  重试合并
                </button>
                <button className="secondary" onClick={scan} disabled={merging}>
                  重新扫描
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {playing && (
        <VideoModal path={playing.path} title={playing.name} onClose={() => setPlaying(null)} />
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
      {confirmingOrientationBatch && (
        <ConfirmDialog
          title="确认分别合并横竖视频"
          deleteCount={0}
          deleteBytes={0}
          danger={false}
          extra={`将分别生成 ${mergeOutputName(workspaceName, 'landscape')}（${orientationBatches.landscape.length} 段）和 ${mergeOutputName(workspaceName, 'portrait')}（${orientationBatches.portrait.length} 段）。两个任务按顺序执行；两项均校验通过后会继续询问是否删除全部源视频。`}
          onConfirm={executeOrientationBatch}
          onCancel={() => setConfirmingOrientationBatch(false)}
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
