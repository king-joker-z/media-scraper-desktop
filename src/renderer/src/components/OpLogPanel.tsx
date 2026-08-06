import { useEffect, useState } from 'react'

interface OpLogEntry {
  file: string
  module: string
  finishedAt: string
  summary: string
}

const MODULE_LABELS: Record<string, string> = {
  clean: '目录清理',
  rename: '批量重命名',
  nfo: 'NFO 归档',
  'merge-delete-sources': '合并源删除',
  'dedupe-delete': '去重删除'
}

/** 操作日志面板（设置页内嵌）：每次执行的删除/改名/移动留档，点击在 Finder 中显示 */
function OpLogPanel(): React.JSX.Element {
  const [logs, setLogs] = useState<OpLogEntry[]>([])

  useEffect(() => {
    window.api.listOpLogs().then(setLogs)
  }, [])

  return (
    <section className="settings-card">
      <h2>操作日志</h2>
      <p className="muted">
        每次执行的删除/改名/移动/归档都会留档（本地 JSON），点击在访达中查看。
      </p>
      {logs.length === 0 ? (
        <p className="muted">暂无记录</p>
      ) : (
        <div className="op-log-list">
          {logs.map((log) => (
            <button
              key={log.file}
              className="op-log-row"
              onClick={() => window.api.revealOpLog(log.file)}
            >
              <span className="op-log-module">{MODULE_LABELS[log.module] ?? log.module}</span>
              <span className="op-log-summary">{log.summary}</span>
              <span className="op-log-time muted">
                {log.finishedAt.replace('T', ' ').slice(0, 19)}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

export default OpLogPanel
