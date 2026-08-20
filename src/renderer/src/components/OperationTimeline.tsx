import { useEffect, useMemo, useRef, useState } from 'react'
import type { OpLogDetail, OpLogSummary, UndoPreflight } from '../../../shared/types'
import ConfirmDialog from './ConfirmDialog'
import OperationDetailPanel from './OperationDetailPanel'
import OperationTimelineItem from './OperationTimelineItem'

type Filter = 'all' | 'undoable' | 'undone' | 'delete' | 'rename' | 'archive' | 'failed'

const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'undoable', label: '可撤销' },
  { id: 'undone', label: '已撤销' },
  { id: 'delete', label: '删除类' },
  { id: 'rename', label: '改名类' },
  { id: 'archive', label: '归档类' },
  { id: 'failed', label: '失败/部分完成' }
]

function OperationTimeline(): React.JSX.Element {
  const [logs, setLogs] = useState<OpLogSummary[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [detail, setDetail] = useState<OpLogDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [preflight, setPreflight] = useState<UndoPreflight | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [notice, setNotice] = useState('')
  const detailRequestId = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = (): void => {
    window.api
      .listOpLogs()
      .then(setLogs)
      .catch(() => setNotice('无法读取本地操作日志'))
  }
  useEffect(() => {
    refresh()
    const unsubscribe = window.api.onOpLogsChange(() => {
      if (refreshTimer.current) return
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null
        refresh()
      }, 120)
    })
    return () => {
      unsubscribe()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [])
  useEffect(() => {
    if (!selectedFile) return
    const requestId = detailRequestId.current + 1
    detailRequestId.current = requestId
    window.api
      .getOpLogDetail(selectedFile)
      .then((nextDetail) => {
        if (detailRequestId.current !== requestId) return
        setDetail(nextDetail)
        setDetailLoading(false)
      })
      .catch(() => {
        if (detailRequestId.current !== requestId) return
        setDetail(null)
        setDetailLoading(false)
        setNotice('日志详情不存在或已损坏')
      })
  }, [selectedFile])
  const visible = useMemo(
    () =>
      logs.filter((log) => {
        if (filter === 'all') return true
        if (filter === 'undoable') return log.undoable
        if (filter === 'undone') return log.undone
        if (filter === 'failed') return log.failedCount > 0
        return log.category === filter
      }),
    [filter, logs]
  )
  const selectLog = (file: string): void => {
    detailRequestId.current += 1
    setSelectedFile(file)
    setDetail(null)
    setDetailLoading(true)
    setPreflight(null)
  }
  const inspectUndo = async (): Promise<void> => {
    if (!selectedFile) return
    setPreflightLoading(true)
    try {
      const nextPreflight = await window.api.preflightUndoOpLog(selectedFile)
      setPreflight(nextPreflight)
      if (!nextPreflight.canUndo && nextPreflight.reason) setNotice(nextPreflight.reason)
    } catch {
      setNotice('撤销预检失败，请稍后重试')
    } finally {
      setPreflightLoading(false)
    }
  }
  const undo = async (): Promise<void> => {
    if (!selectedFile) return
    setUndoing(true)
    setNotice('')
    try {
      const report = await window.api.undoOpLog(selectedFile)
      setNotice(
        `撤销完成：回退 ${report.undone} 项${report.skipped ? `，跳过 ${report.skipped} 项` : ''}${report.failed.length ? `，失败 ${report.failed.length} 项` : ''}`
      )
      await Promise.all([
        window.api.listOpLogs().then(setLogs),
        window.api.getOpLogDetail(selectedFile).then(setDetail)
      ])
      setPreflight(null)
    } catch (error) {
      setNotice(`撤销失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setUndoing(false)
    }
  }
  return (
    <section className="settings-card operation-timeline workbench-operation-timeline">
      <div className="op-log-heading">
        <div>
          <span className="section-kicker">本地可追溯</span>
          <h2>操作时间线</h2>
        </div>
        <span className="status-badge status-running">
          <span className="status-badge-mark" aria-hidden="true" />
          {logs.length} 条记录
        </span>
      </div>
      <p className="muted">
        按时间回看文件变更；只有可安全反向执行的改名与归档操作才会开放撤销预检。
      </p>
      {notice && (
        <p className="notice-inline" role="status">
          {notice}
        </p>
      )}
      <div className="operation-filter-tabs" role="toolbar" aria-label="筛选操作日志">
        {filters.map((item) => (
          <button
            key={item.id}
            className={filter === item.id ? 'active' : ''}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <div className="op-log-empty">
          <span className="op-log-empty-mark" aria-hidden="true" />
          <b>没有匹配的操作记录</b>
          <span>完成一次文件处理后，记录会自动保存在这里。</span>
        </div>
      ) : (
        <div className="operation-timeline-layout">
          <div className="operation-timeline-list">
            {visible.map((log) => (
              <OperationTimelineItem
                key={log.file}
                log={log}
                selected={selectedFile === log.file}
                onSelect={() => selectLog(log.file)}
              />
            ))}
          </div>
          <OperationDetailPanel
            detail={detail}
            loading={detailLoading}
            preflight={preflight}
            preflightLoading={preflightLoading}
            onReveal={() => selectedFile && window.api.revealOpLog(selectedFile)}
            onPreflight={inspectUndo}
          />
        </div>
      )}
      {preflight?.canUndo && (
        <ConfirmDialog
          title="确认撤销本次操作"
          deleteCount={0}
          deleteBytes={0}
          danger={false}
          extra={`将按日志反向恢复文件位置。可恢复 ${preflight.ready} 项，跳过 ${preflight.skipped} 项，可能重名 ${preflight.collisions} 项。`}
          ackLabel="我已了解，确认撤销"
          confirmLabel="执行撤销"
          onConfirm={undo}
          onCancel={() => setPreflight(null)}
        />
      )}
      {undoing && <p className="muted">正在撤销，文件操作完成前请勿关闭应用…</p>}
    </section>
  )
}
export default OperationTimeline
