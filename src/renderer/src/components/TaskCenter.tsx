import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskEvent } from '../../../shared/types'

const MAX_EVENTS = 50
const FILTER_ALL = '__all__'

function TaskCenter(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [filter, setFilter] = useState(FILTER_ALL)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const unsubscribe = window.api.onTaskEvent((event) => {
      setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS))
    })
    return unsubscribe
  }, [])

  // 出现过的任务名（按事件里的 label 归组），供按任务过滤
  const labels = useMemo(() => [...new Set(events.map((event) => event.label))], [events])
  const visible = useMemo(
    () => (filter === FILTER_ALL ? events : events.filter((event) => event.label === filter)),
    [events, filter]
  )

  const terminalIds = useMemo(
    () =>
      new Set(
        events
          .filter(
            (event) =>
              event.type === 'done' || event.type === 'failed' || event.type === 'cancelled'
          )
          .map((event) => event.taskId)
      ),
    [events]
  )
  const active = events.find(
    (event) =>
      (event.type === 'start' || event.type === 'progress' || event.type === 'item-done') &&
      !terminalIds.has(event.taskId)
  )
  const running = Boolean(active)

  return (
    <div className="task-center">
      {open && (
        <div className="task-panel">
          <div className="task-panel-header">
            <div className="task-panel-title">
              <span
                className={`task-panel-status ${running ? 'running' : ''}`}
                aria-hidden="true"
              />
              <div>
                <b>任务中心</b>
                <small>
                  {running
                    ? '正在处理队列'
                    : events.length
                      ? `保留最近 ${events.length} 条动态`
                      : '等待新的工作'}
                </small>
              </div>
            </div>
            <div className="task-panel-actions">
              {labels.length > 1 && (
                <select
                  className="task-filter"
                  aria-label="筛选任务记录"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                >
                  <option value={FILTER_ALL}>全部任务</option>
                  {labels.map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
              <button
                className="task-clear"
                disabled={events.length === 0}
                aria-label="清空任务记录"
                onClick={() => {
                  setEvents([])
                  setFilter(FILTER_ALL)
                }}
              >
                清空
              </button>
            </div>
          </div>
          <div className="task-list" ref={listRef} aria-live="polite">
            {visible.length === 0 ? (
              <div className="task-empty-state">
                <b>这里会显示处理进度</b>
                <span>执行整理、重命名或合并后，可在此查看每一步状态。</span>
              </div>
            ) : (
              visible.map((event, index) => (
                <div key={`${event.at}-${index}`} className={`task-row ${event.type}`}>
                  <span className="task-event-icon" aria-hidden="true">
                    <TaskGlyph type={event.type} />
                  </span>
                  <div className="task-row-body">
                    <div className="task-row-topline">
                      <span className="task-type">{eventLabel(event.type)}</span>
                      <span className="task-count">
                        {event.total > 0 ? `${event.completed}/${event.total}` : '处理中'}
                        {event.failed > 0 && (
                          <em className="task-failed-count">失败 {event.failed}</em>
                        )}
                      </span>
                    </div>
                    <span className="task-label" title={event.current ?? event.label}>
                      {event.current ?? event.label}
                    </span>
                    {(event.type === 'done' ||
                      event.type === 'failed' ||
                      event.type === 'cancelled') && (
                      <span className="task-result-summary">
                        {event.type === 'done'
                          ? `完成 ${event.completed} 项${event.failed ? `，失败 ${event.failed} 项` : ''}`
                          : event.type === 'cancelled'
                            ? `已取消，已完成 ${event.completed} 项`
                            : `执行失败${event.error ? '，请查看原因后重试' : ''}`}
                      </span>
                    )}
                    {event.error && (
                      <span className="task-error" title={event.error}>
                        原因：{event.error}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <button
        className="task-fab"
        aria-label={open ? '关闭任务中心' : '打开任务中心'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`task-fab-mark ${running ? 'running' : ''}`} aria-hidden="true" />
        任务
        {events.length > 0 && <span className="task-badge">{events.length}</span>}
      </button>
    </div>
  )
}

function TaskGlyph({ type }: { type: TaskEvent['type'] }): React.JSX.Element {
  if (type === 'item-error') {
    return (
      <svg viewBox="0 0 16 16">
        <path d="M8 2.1 14 13H2L8 2.1Zm0 4v3.5m0 1.8v.1" />
      </svg>
    )
  }
  if (type === 'done' || type === 'item-done') {
    return (
      <svg viewBox="0 0 16 16">
        <path d="m3 8.1 3.1 3.1L13 4.8" />
      </svg>
    )
  }
  if (type === 'failed') {
    return (
      <svg viewBox="0 0 16 16">
        <path d="M8 2.1 14 13H2L8 2.1Zm0 4v3.5m0 1.8v.1" />
      </svg>
    )
  }
  if (type === 'cancelled') {
    return (
      <svg viewBox="0 0 16 16">
        <path d="m5 5 6 6m0-6-6 6" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16">
      <path d="M8 3.1v4.5l3 1.9M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z" />
    </svg>
  )
}

function eventLabel(type: TaskEvent['type']): string {
  switch (type) {
    case 'start':
      return '开始'
    case 'progress':
      return '进行'
    case 'item-done':
      return '完成'
    case 'item-error':
      return '失败'
    case 'done':
      return '结束'
    case 'failed':
      return '失败结束'
    case 'cancelled':
      return '取消'
  }
}

export default TaskCenter
