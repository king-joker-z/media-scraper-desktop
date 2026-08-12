import { useEffect, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'

interface OpLogEntry {
  file: string
  module: string
  finishedAt: string
  summary: string
  undone: boolean
  undoable: boolean
}

const MODULE_LABELS: Record<string, string> = {
  clean: '目录清理',
  rename: '批量重命名',
  nfo: 'NFO 归档',
  'merge-delete-sources': '合并源删除',
  'dedupe-delete': '去重删除',
  undo: '一键撤销'
}

/** 操作日志面板（设置页内嵌）：每次执行的删除/改名/移动留档，可定位文件；改名/归档支持一键撤销 */
function OpLogPanel(): React.JSX.Element {
  const [logs, setLogs] = useState<OpLogEntry[]>([])
  const [undoTarget, setUndoTarget] = useState<OpLogEntry | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [notice, setNotice] = useState('')

  const refresh = (): void => {
    window.api
      .listOpLogs()
      .then(setLogs)
      .catch(() => {})
  }

  useEffect(() => {
    refresh()
  }, [])

  const undo = async (): Promise<void> => {
    if (!undoTarget) return
    setUndoing(true)
    setNotice('')
    try {
      const report = await window.api.undoOpLog(undoTarget.file)
      setNotice(
        `已撤销：回退 ${report.undone} 项` +
          (report.skipped ? `，跳过 ${report.skipped} 项（文件已不在原位）` : '') +
          (report.failed.length ? `，失败 ${report.failed.length} 项` : '')
      )
      refresh()
    } catch (error) {
      setNotice(`撤销失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setUndoing(false)
      setUndoTarget(null)
    }
  }

  return (
    <section className="settings-card op-log-panel">
      <div className="op-log-heading">
        <div>
          <span className="section-kicker">本地可追溯</span>
          <h2>操作日志</h2>
        </div>
        <span className="op-log-total">{logs.length} 条记录</span>
      </div>
      <p className="muted">
        每次删除、改名、移动和归档都会留存本地记录。选择记录可在文件管理器中定位；重命名与 NFO
        归档可安全撤销。
      </p>
      {notice && <p className="notice-inline">{notice}</p>}
      {logs.length === 0 ? (
        <div className="op-log-empty">
          <span className="op-log-empty-mark" aria-hidden="true" />
          <b>还没有可追溯的操作</b>
          <span>完成一次文件处理后，记录会自动保存在这里。</span>
        </div>
      ) : (
        <div className="op-log-list">
          {logs.map((log) => (
            <div key={log.file} className={`op-log-row-wrap ${log.undone ? 'undone' : ''}`}>
              <button
                className="op-log-row"
                title="在文件管理器中定位此操作日志"
                onClick={() => window.api.revealOpLog(log.file)}
              >
                <span className="op-log-icon" aria-hidden="true">
                  <LogGlyph module={log.module} />
                </span>
                <span className="op-log-content">
                  <span className="op-log-module">
                    {MODULE_LABELS[log.module] ?? log.module}
                    {log.undone && <em>已撤销</em>}
                  </span>
                  <span className="op-log-summary">{log.summary}</span>
                </span>
                <span className="op-log-time">{log.finishedAt.replace('T', ' ').slice(0, 16)}</span>
              </button>
              {log.undoable && (
                <button
                  className="op-log-undo"
                  title="按此日志反向恢复文件位置"
                  aria-label={`撤销${MODULE_LABELS[log.module] ?? log.module}`}
                  onClick={() => setUndoTarget(log)}
                >
                  <span aria-hidden="true">↩</span> 撤销
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {undoTarget && (
        <ConfirmDialog
          title="撤销本次操作"
          deleteCount={0}
          deleteBytes={0}
          danger={false}
          extra={`将按日志反向恢复「${MODULE_LABELS[undoTarget.module] ?? undoTarget.module}」的文件位置（${undoTarget.summary}）。已被移动/删除的源文件会跳过。`}
          ackLabel="我已了解，确认撤销"
          onConfirm={undo}
          onCancel={() => setUndoTarget(null)}
        />
      )}
      {undoing && <p className="muted">正在撤销…</p>}
    </section>
  )
}

function LogGlyph({ module }: { module: string }): React.JSX.Element {
  if (module === 'clean' || module === 'dedupe-delete' || module === 'merge-delete-sources') {
    return (
      <svg viewBox="0 0 16 16">
        <path d="M3 4.5h10m-7.2 0 .5-1.5h3.4l.5 1.5m-5.8 0 .5 8.5h6.4l.5-8.5M7 7v3.5m2-3.5v3.5" />
      </svg>
    )
  }
  if (module === 'undo') {
    return (
      <svg viewBox="0 0 16 16">
        <path d="M6.2 4 3 7.2l3.2 3.2M3.3 7.2h5.1a4.3 4.3 0 0 1 4.3 4.3" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16">
      <path d="M3 3.2h7.1L13 6.1v6.7H3V3.2Zm7 0v3h3" />
    </svg>
  )
}

export default OpLogPanel
