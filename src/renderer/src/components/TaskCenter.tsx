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

  const active = events.find((event) => event.type === 'start' || event.type === 'progress')
  const running =
    active &&
    !events.some(
      (event) =>
        event.taskId === active.taskId && (event.type === 'done' || event.type === 'cancelled')
    )

  return (
    <div className="task-center">
      {open && (
        <div className="task-panel">
          <div className="task-panel-header">
            <b>任务中心</b>
            {labels.length > 1 && (
              <select
                className="task-filter"
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
              className="chip-remove"
              onClick={() => {
                setEvents([])
                setFilter(FILTER_ALL)
              }}
            >
              清空
            </button>
          </div>
          <div className="task-list" ref={listRef}>
            {visible.length === 0 && <p className="muted">暂无任务记录</p>}
            {visible.map((event, index) => (
              <div key={`${event.at}-${index}`} className={`task-row ${event.type}`}>
                <span className="task-type">{eventLabel(event.type)}</span>
                <span className="task-label" title={event.current}>
                  {event.current ?? event.label}
                </span>
                <span className="task-count">
                  {event.completed}/{event.total}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <button className="task-fab" onClick={() => setOpen((value) => !value)}>
        {running ? '⏳' : '📋'} 任务
        {events.length > 0 && <span className="task-badge">{events.length}</span>}
      </button>
    </div>
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
    case 'cancelled':
      return '取消'
  }
}

export default TaskCenter
