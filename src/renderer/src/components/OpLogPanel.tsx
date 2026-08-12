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
    <section className="settings-card">
      <h2>操作日志</h2>
      <p className="muted">
        每次执行的删除/改名/移动/归档都会留档（本地 JSON），点击行在文件管理器中定位； 重命名与 NFO
        归档支持一键撤销（删除类请从系统回收站恢复）。
      </p>
      {notice && <p className="notice-inline">{notice}</p>}
      {logs.length === 0 ? (
        <p className="muted">暂无记录</p>
      ) : (
        <div className="op-log-list">
          {logs.map((log) => (
            <div key={log.file} className="op-log-row-wrap">
              <button className="op-log-row" onClick={() => window.api.revealOpLog(log.file)}>
                <span className="op-log-module">
                  {MODULE_LABELS[log.module] ?? log.module}
                  {log.undone && '（已撤销）'}
                </span>
                <span className="op-log-summary">{log.summary}</span>
                <span className="op-log-time muted">
                  {log.finishedAt.replace('T', ' ').slice(0, 19)}
                </span>
              </button>
              {log.undoable && (
                <button
                  className="chip-remove"
                  title="按此日志反向恢复文件位置"
                  onClick={() => setUndoTarget(log)}
                >
                  ↩ 撤销
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

export default OpLogPanel
