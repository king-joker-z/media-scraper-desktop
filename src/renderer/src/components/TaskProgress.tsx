import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskEvent } from '../../../shared/types'

const AUTO_DISMISS_MS = 3000

const isTerminal = (event: TaskEvent): boolean =>
  event.type === 'done' || event.type === 'failed' || event.type === 'cancelled'

/** 长任务结束时发系统通知（仅当窗口在后台，避免打扰前台操作） */
const notifyTaskFinished = (event: TaskEvent): void => {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  if (document.visibilityState !== 'hidden') return
  const body =
    event.type === 'cancelled'
      ? '已取消'
      : event.type === 'failed'
        ? event.error || '执行失败'
        : `完成 ${event.completed}/${event.total}${event.failed > 0 ? `，失败 ${event.failed}` : ''}`
  new Notification(`Media Scraper · ${event.label}`, { body })
}

/**
 * 全局执行进度条：每个 taskId 只能从进行中转为一次终态，终态后自动隐藏。
 * 即使主进程发生未预期异常，用户也可以单独关闭遗留卡片；被关闭的任务不再被延迟 IPC 事件复活。
 */
function TaskProgress(): React.JSX.Element | null {
  const [tasks, setTasks] = useState<Map<string, TaskEvent>>(new Map())
  const [taskStartedAt, setTaskStartedAt] = useState<Map<string, number>>(new Map())
  const terminalTaskIds = useRef(new Set<string>())
  const dismissedTaskIds = useRef(new Set<string>())
  const dismissTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((taskId: string): void => {
    const timer = dismissTimers.current.get(taskId)
    if (timer) clearTimeout(timer)
    dismissTimers.current.delete(taskId)
    dismissedTaskIds.current.add(taskId)
    terminalTaskIds.current.delete(taskId)
    setTaskStartedAt((prev) => {
      const next = new Map(prev)
      next.delete(taskId)
      return next
    })
    setTasks((prev) => {
      const next = new Map(prev)
      next.delete(taskId)
      return next
    })
  }, [])

  useEffect(() => {
    const timers = dismissTimers.current
    const unsubscribe = window.api.onTaskEvent((event) => {
      const terminal = isTerminal(event)
      // 已手动关闭的卡片及已经到达终态的任务，不能被 IPC 队列中的旧事件重新显示。
      if (dismissedTaskIds.current.has(event.taskId)) return
      if (!terminal && terminalTaskIds.current.has(event.taskId)) return

      setTaskStartedAt((prev) => {
        if (prev.has(event.taskId) && event.type !== 'start') return prev
        const next = new Map(prev)
        next.set(event.taskId, event.at)
        return next
      })
      setTasks((prev) => {
        const next = new Map(prev)
        next.set(event.taskId, event)
        return next
      })

      if (terminal) {
        terminalTaskIds.current.add(event.taskId)
        notifyTaskFinished(event)
        const previous = timers.get(event.taskId)
        if (previous) clearTimeout(previous)
        timers.set(
          event.taskId,
          setTimeout(() => dismiss(event.taskId), AUTO_DISMISS_MS)
        )
      }
    })
    return () => {
      unsubscribe()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [dismiss])

  if (tasks.size === 0) return null

  return (
    <div className="task-progress-stack" aria-live="polite">
      {[...tasks.values()].map((task) => {
        const terminal = isTerminal(task)
        // total 为 0 表示不定量任务（如目录扫描），用不定态进度条
        const indeterminate = task.total === 0 && !terminal
        const percent = task.total > 0 ? Math.round((task.completed / task.total) * 100) : 0
        const elapsedMs = Math.max(0, task.at - (taskStartedAt.get(task.taskId) ?? task.at))
        const rate = elapsedMs > 0 && task.completed > 0 ? task.completed / (elapsedMs / 1000) : 0
        const etaSeconds =
          rate > 0 && task.total > task.completed
            ? Math.ceil((task.total - task.completed) / rate)
            : 0
        const etaText =
          etaSeconds > 0
            ? `约剩余 ${Math.floor(etaSeconds / 60)}:${String(etaSeconds % 60).padStart(2, '0')}`
            : ''
        const rateText = rate >= 0.1 ? `${rate.toFixed(rate >= 10 ? 0 : 1)} 项/秒` : ''
        const status =
          task.type === 'cancelled'
            ? '已取消'
            : task.type === 'failed'
              ? '失败'
              : task.type === 'done'
                ? '完成'
                : indeterminate
                  ? '进行中…'
                  : `${task.completed}/${task.total}`
        return (
          <div
            key={task.taskId}
            className={`task-progress-card ${terminal ? 'finished' : ''} ${task.type === 'failed' ? 'failed' : ''}`}
          >
            <div className="task-progress-head">
              <b>{task.label}</b>
              <div className="task-progress-actions">
                <span>
                  {status}
                  {task.failed > 0 && task.type !== 'failed' && (
                    <em className="danger-text">（失败 {task.failed}）</em>
                  )}
                </span>
                <button
                  className="task-progress-dismiss"
                  type="button"
                  aria-label={`关闭${task.label}进度提示`}
                  title="关闭此进度提示"
                  onClick={() => dismiss(task.taskId)}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="progress-track">
              <div
                className={`progress-bar ${task.type === 'cancelled' ? 'cancelled' : ''} ${
                  task.type === 'failed' ? 'failed' : ''
                } ${indeterminate ? 'indeterminate' : ''}`}
                style={{ width: indeterminate ? undefined : `${percent}%` }}
              />
            </div>
            {(task.type === 'failed' || (!terminal && (task.current || rateText || etaText))) && (
              <p className="task-progress-current" title={task.error || task.current}>
                {task.error || task.current}
                {!terminal && (rateText || etaText) && (
                  <span> · {[rateText, etaText].filter(Boolean).join(' · ')}</span>
                )}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default TaskProgress
