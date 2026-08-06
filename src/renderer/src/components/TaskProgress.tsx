import { useEffect, useState } from 'react'
import type { TaskEvent } from '../../../shared/types'

/**
 * 全局执行进度条：订阅任务中心事件，以浮动卡片形式展示每个进行中任务的
 * 进度条 / 完成数 / 当前处理项，结束后 3 秒自动消失。所有模块共用。
 */
function TaskProgress(): React.JSX.Element | null {
  const [tasks, setTasks] = useState<Map<string, TaskEvent>>(new Map())

  useEffect(() => {
    return window.api.onTaskEvent((event) => {
      setTasks((prev) => {
        const next = new Map(prev)
        next.set(event.taskId, event)
        return next
      })
      if (event.type === 'done' || event.type === 'cancelled') {
        setTimeout(() => {
          setTasks((prev) => {
            const next = new Map(prev)
            next.delete(event.taskId)
            return next
          })
        }, 3000)
      }
    })
  }, [])

  if (tasks.size === 0) return null

  return (
    <div className="task-progress-stack">
      {[...tasks.values()].map((task) => {
        const finished = task.type === 'done' || task.type === 'cancelled'
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
                  : `${task.completed}/${task.total}`}
                {task.failed > 0 && <em className="danger-text">（失败 {task.failed}）</em>}
              </span>
            </div>
            <div className="progress-track">
              <div
                className={`progress-bar ${task.type === 'cancelled' ? 'cancelled' : ''}`}
                style={{ width: `${percent}%` }}
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
