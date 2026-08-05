import { useEffect, useRef, useState } from 'react'
import type { TaskEvent } from '../../../shared/types'

const MAX_EVENTS = 50

function TaskCenter(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const unsubscribe = window.api.onTaskEvent((event) => {
      setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS))
    })
    return unsubscribe
  }, [])

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
            <button className="chip-remove" onClick={() => setEvents([])}>
              清空
            </button>
          </div>
          <div className="task-list" ref={listRef}>
            {events.length === 0 && <p className="muted">暂无任务记录</p>}
            {events.map((event, index) => (
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
