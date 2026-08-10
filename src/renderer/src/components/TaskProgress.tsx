import { useEffect, useRef, useState } from 'react'
import type { TaskEvent } from '../../../shared/types'

/**
 * 全局执行进度条：订阅任务中心事件，以浮动卡片形式展示每个进行中任务的
 * 进度条 / 完成数 / 当前处理项，结束后 3 秒自动消失。所有模块共用。
 */
/** 长任务结束时发系统通知（仅当窗口在后台，避免打扰前台操作） */
const notifyTaskFinished = (event: TaskEvent): void => {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  if (document.visibilityState !== 'hidden') return
  const body =
    event.type === 'cancelled'
      ? '已取消'
      : `完成 ${event.completed}/${event.total}${event.failed > 0 ? `，失败 ${event.failed}` : ''}`
  new Notification(`Media Scraper · ${event.label}`, { body })
}

function TaskProgress(): React.JSX.Element | null {
  const [tasks, setTasks] = useState<Map<string, TaskEvent>>(new Map())
  const finishedTaskIds = useRef(new Set<string>())
  const dismissTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const timers = dismissTimers.current
    const unsubscribe = window.api.onTaskEvent((event) => {
      const finished = event.type === 'done' || event.type === 'cancelled'
      // IPC 队列拥堵时，终态后抵达的旧进度事件不得让任务“复活”。
      if (!finished && finishedTaskIds.current.has(event.taskId)) return
      setTasks((prev) => {
        const next = new Map(prev)
        next.set(event.taskId, event)
        return next
      })
      if (finished) {
        finishedTaskIds.current.add(event.taskId)
        notifyTaskFinished(event)
        const existing = timers.get(event.taskId)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          timers.delete(event.taskId)
          finishedTaskIds.current.delete(event.taskId)
          setTasks((prev) => {
            const next = new Map(prev)
            next.delete(event.taskId)
            return next
          })
        }, 3000)
        timers.set(event.taskId, timer)
      }
    })
    return () => {
      unsubscribe()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  if (tasks.size === 0) return null

  return (
    <div className="task-progress-stack">
      {[...tasks.values()].map((task) => {
        const finished = task.type === 'done' || task.type === 'cancelled'
        // total 为 0 表示不定量任务（如目录扫描），用不定态进度条
        const indeterminate = task.total === 0 && !finished
        const percent = task.total > 0 ? Math.round((task.completed / task.total) * 100) : 0
        return (
          <div key={task.taskId} className={`task-progress-card ${finished ? 'finished' : ''}`}>
            <div className="task-progress-head">
              <b>{task.label}</b>
              <span>
                {finished
                  ? task.type === 'cancelled'
                    ? '已取消'
                    : '完成'
                  : indeterminate
                    ? '进行中…'
                    : `${task.completed}/${task.total}`}
                {task.failed > 0 && <em className="danger-text">（失败 {task.failed}）</em>}
              </span>
            </div>
            <div className="progress-track">
              <div
                className={`progress-bar ${task.type === 'cancelled' ? 'cancelled' : ''} ${
                  indeterminate ? 'indeterminate' : ''
                }`}
                style={{ width: indeterminate ? undefined : `${percent}%` }}
              />
            </div>
            {!finished && task.current && <p className="task-progress-current">{task.current}</p>}
          </div>
        )
      })}
    </div>
  )
}

export default TaskProgress
