import { useEffect, useMemo, useState } from 'react'
import type { TaskEvent } from '../../../shared/types'
import {
  getTaskResultText,
  getTaskStatusText,
  getTaskVisualState,
  isTerminalTask
} from './task-display'
import type { TaskFeed, TaskFeedItem } from './useTaskFeed'

const FILTER_ALL = '__all__'
const CANCEL_WAIT_NOTICE_MS = 10_000

function TaskCenter({ feed }: { feed: TaskFeed }): React.JSX.Element {
  const { tasks, activeTasks, historyTasks, clearHistory } = feed
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState(FILTER_ALL)
  const [cancellingTaskIds, setCancellingTaskIds] = useState<Set<string>>(new Set())
  const [cancelRequestedAt, setCancelRequestedAt] = useState<Map<string, number>>(new Map())
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    const openQueue = (): void => setOpen(true)
    const closeQueue = (): void => setOpen(false)
    window.addEventListener('task-center:open', openQueue)
    window.addEventListener('task-center:close', closeQueue)
    return () => {
      window.removeEventListener('task-center:open', openQueue)
      window.removeEventListener('task-center:close', closeQueue)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setOpen((value) => !value)
      } else if (event.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const labels = useMemo(() => [...new Set(tasks.map((task) => task.event.label))], [tasks])
  const effectiveFilter = filter !== FILTER_ALL && !labels.includes(filter) ? FILTER_ALL : filter
  const visible = useMemo(
    () =>
      effectiveFilter === FILTER_ALL
        ? tasks
        : tasks.filter((task) => task.event.label === effectiveFilter),
    [effectiveFilter, tasks]
  )
  const active = visible.filter((task) => !isTerminalTask(task.event))
  const history = visible.filter((task) => isTerminalTask(task.event))
  const liveSummary = activeTasks[0]?.event
    ? `${activeTasks[0].event.label}：${getTaskStatusText(activeTasks[0].event)}`
    : ''

  useEffect(() => {
    if (cancellingTaskIds.size === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [cancellingTaskIds])

  useEffect(() => {
    const terminalIds = new Set(
      tasks.filter((task) => isTerminalTask(task.event)).map((task) => task.event.taskId)
    )
    if (terminalIds.size === 0) return
    const timer = window.setTimeout(() => {
      setCancellingTaskIds(
        (previous) => new Set([...previous].filter((taskId) => !terminalIds.has(taskId)))
      )
      setCancelRequestedAt(
        (previous) => new Map([...previous].filter(([taskId]) => !terminalIds.has(taskId)))
      )
    }, 0)
    return () => window.clearTimeout(timer)
  }, [tasks])

  useEffect(() => {
    if (filter === FILTER_ALL || labels.includes(filter)) return
    const timer = window.setTimeout(() => setFilter(FILTER_ALL), 0)
    return () => window.clearTimeout(timer)
  }, [filter, labels])

  return (
    <div className="task-center">
      {open && (
        <section className="task-panel" aria-label="任务队列">
          <p className="visually-hidden" aria-live="polite" aria-atomic="true">
            {liveSummary}
          </p>
          <header className="task-panel-header">
            <div className="task-panel-title">
              <span
                className={`task-panel-status ${activeTasks.length ? 'running' : ''}`}
                aria-hidden="true"
              />
              <div>
                <b>任务队列</b>
                <small>
                  {activeTasks.length
                    ? `正在处理 ${activeTasks.length} 个任务`
                    : '没有正在执行的任务'}
                </small>
              </div>
            </div>
            <div className="task-panel-actions">
              {labels.length > 1 && (
                <select
                  className="task-filter"
                  aria-label="按任务名称筛选"
                  value={effectiveFilter}
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
                disabled={historyTasks.length === 0}
                onClick={clearHistory}
              >
                清空历史
              </button>
              <button
                className="task-close"
                type="button"
                aria-label="关闭任务队列"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
          </header>
          <div className="task-list">
            {visible.length === 0 ? (
              <div className="task-empty-state">
                <b>这里会显示处理进度</b>
                <span>执行整理、重命名或合并后，可在此查看每一步状态。</span>
              </div>
            ) : (
              <>
                {active.length > 0 && (
                  <TaskGroup
                    title="活动队列"
                    tasks={active}
                    cancellingTaskIds={cancellingTaskIds}
                    cancelRequestedAt={cancelRequestedAt}
                    now={now}
                    onCancel={(taskId) => {
                      const requestedAt = Date.now()
                      setCancellingTaskIds((previous) => new Set(previous).add(taskId))
                      setCancelRequestedAt((previous) => new Map(previous).set(taskId, requestedAt))
                      void window.api
                        .cancelTask(taskId)
                        .then((accepted) => {
                          if (accepted) return
                          setCancellingTaskIds((previous) => {
                            const next = new Set(previous)
                            next.delete(taskId)
                            return next
                          })
                          setCancelRequestedAt((previous) => {
                            const next = new Map(previous)
                            next.delete(taskId)
                            return next
                          })
                        })
                        .catch(() => {
                          setCancellingTaskIds((previous) => {
                            const next = new Set(previous)
                            next.delete(taskId)
                            return next
                          })
                          setCancelRequestedAt((previous) => {
                            const next = new Map(previous)
                            next.delete(taskId)
                            return next
                          })
                        })
                    }}
                  />
                )}
                {history.length > 0 && <TaskGroup title="近期结果" tasks={history} />}
              </>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

function TaskGroup({
  title,
  tasks,
  cancellingTaskIds = new Set(),
  cancelRequestedAt = new Map(),
  now = null,
  onCancel
}: {
  title: string
  tasks: TaskFeedItem[]
  cancellingTaskIds?: Set<string>
  cancelRequestedAt?: Map<string, number>
  now?: number | null
  onCancel?: (taskId: string) => void
}): React.JSX.Element {
  return (
    <section className="task-group" aria-label={title}>
      <h2>{title}</h2>
      <div role="list">
        {tasks.map(({ event, startedAt }) => (
          <TaskRow
            key={event.taskId}
            event={event}
            startedAt={startedAt}
            cancelling={cancellingTaskIds.has(event.taskId)}
            cancelWaiting={
              now !== null &&
              now - (cancelRequestedAt.get(event.taskId) ?? now) >= CANCEL_WAIT_NOTICE_MS
            }
            onCancel={onCancel}
          />
        ))}
      </div>
    </section>
  )
}

function TaskRow({
  event,
  startedAt,
  cancelling = false,
  cancelWaiting = false,
  onCancel
}: {
  event: TaskEvent
  startedAt: number
  cancelling?: boolean
  cancelWaiting?: boolean
  onCancel?: (taskId: string) => void
}): React.JSX.Element {
  const state = getTaskVisualState(event)
  return (
    <article
      className={`task-row ${state}`}
      role="listitem"
      title={event.error || event.current || event.label}
    >
      <span className="task-event-icon" aria-hidden="true">
        <TaskGlyph type={event.type} />
      </span>
      <span className="task-row-body">
        <span className="task-row-topline">
          <b>{event.label}</b>
          <span className="task-row-status">
            {event.encoder && (
              <span className={`task-encoder ${event.encoder}`}>{encoderLabel(event.encoder)}</span>
            )}
            <span className="task-count">{getTaskStatusText(event)}</span>
          </span>
        </span>
        <span className="task-label">{event.current || getTaskResultText(event)}</span>
        {event.failed > 0 && <span className="task-failed-count">失败 {event.failed}</span>}
        {event.error && (
          <details className="task-error-details">
            <summary>查看错误详情</summary>
            <pre>{event.error}</pre>
          </details>
        )}
        {!isTerminalTask(event) && (
          <span className="task-row-actions">
            <span className="task-elapsed">
              {cancelling
                ? cancelWaiting
                  ? '仍在等待在途项退出'
                  : '正在请求停止并收尾…'
                : `已运行 ${formatElapsed(event.at - startedAt)}`}
            </span>
            {cancelWaiting && (
              <details className="task-cancel-details">
                <summary>仍在等待在途项退出</summary>
                <span>已停止派发新任务；正在运行的文件处理会在安全收尾后结束。</span>
              </details>
            )}
            {onCancel && (
              <button
                className="task-cancel"
                type="button"
                disabled={cancelling}
                onClick={() => onCancel(event.taskId)}
              >
                {cancelling ? '正在停止' : '取消'}
              </button>
            )}
          </span>
        )}
      </span>
    </article>
  )
}

function encoderLabel(encoder: NonNullable<TaskEvent['encoder']>): string {
  if (encoder === 'nvenc') return 'NVENC'
  if (encoder === 'fallback') return '已回退 CPU'
  if (encoder === 'cpu') return 'CPU'
  return '直拼'
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function TaskGlyph({ type }: { type: TaskEvent['type'] }): React.JSX.Element {
  if (type === 'done' || type === 'item-done')
    return (
      <svg viewBox="0 0 16 16">
        <path d="m3 8.1 3.1 3.1L13 4.8" />
      </svg>
    )
  if (type === 'failed' || type === 'item-error')
    return (
      <svg viewBox="0 0 16 16">
        <path d="M8 2.1 14 13H2L8 2.1Zm0 4v3.5m0 1.8v.1" />
      </svg>
    )
  if (type === 'cancelled')
    return (
      <svg viewBox="0 0 16 16">
        <path d="m5 5 6 6m0-6-6 6" />
      </svg>
    )
  return (
    <svg viewBox="0 0 16 16">
      <path d="M8 3.1v4.5l3 1.9M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z" />
    </svg>
  )
}

export default TaskCenter
