import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import {
  formatTaskEta,
  formatTaskRate,
  getTaskPercent,
  getTaskRate,
  getTaskResultText,
  getTaskStatusText,
  getTaskVisualState,
  isIndeterminateTask,
  isTerminalTask
} from './task-display'
import type { TaskFeed } from './useTaskFeed'

const AUTO_COLLAPSE_MS = 5000

function TaskIsland({ feed }: { feed: TaskFeed }): React.JSX.Element {
  const { tasks, activeTasks, dismissTask } = feed
  const [expanded, setExpanded] = useState(false)
  const [pinnedTaskId, setPinnedTaskId] = useState<string | null>(null)
  const reduceMotion = useReducedMotion()
  const automaticLead = useMemo(() => activeTasks[0] ?? tasks[0], [activeTasks, tasks])
  const pinnedLead = pinnedTaskId
    ? tasks.find((task) => task.event.taskId === pinnedTaskId)
    : undefined
  const lead = pinnedLead ?? automaticLead

  useEffect(() => {
    if (!lead || !isTerminalTask(lead.event) || !expanded) return
    const timer = window.setTimeout(() => {
      setExpanded(false)
      setPinnedTaskId(null)
    }, AUTO_COLLAPSE_MS)
    return () => window.clearTimeout(timer)
  }, [expanded, lead])

  useEffect(() => {
    const collapseDetail = (): void => {
      setExpanded(false)
      setPinnedTaskId(null)
    }
    window.addEventListener('task-center:open', collapseDetail)
    return () => window.removeEventListener('task-center:open', collapseDetail)
  }, [])

  if (!lead) {
    return (
      <div className="task-island-host">
        <button
          className="task-island task-island-idle"
          type="button"
          aria-label="打开任务队列，当前没有进行中的任务"
          onClick={() => window.dispatchEvent(new Event('task-center:open'))}
        >
          <span className="task-island-state" aria-hidden="true">
            ⌁
          </span>
          <span className="task-island-copy">
            <b>任务</b>
            <small>暂无进行中的任务</small>
          </span>
        </button>
      </div>
    )
  }

  const { event, startedAt } = lead
  const terminal = isTerminalTask(event)
  const state = getTaskVisualState(event)
  const percent = getTaskPercent(event)
  const rateText = formatTaskRate(getTaskRate(event, startedAt))
  const etaText = formatTaskEta(event, startedAt)
  const indeterminate = isIndeterminateTask(event)
  const otherActiveTaskCount = activeTasks.filter(
    (task) => task.event.taskId !== event.taskId
  ).length
  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.16, ease: [0.2, 0, 0, 1] as const }

  const toggleExpanded = (): void => {
    if (expanded) {
      setExpanded(false)
      setPinnedTaskId(null)
      return
    }
    window.dispatchEvent(new Event('task-center:close'))
    if (terminal) setPinnedTaskId(event.taskId)
    setExpanded(true)
  }

  return (
    <div className="task-island-host">
      <motion.button
        className={`task-island task-island-${state} ${expanded ? 'expanded' : ''}`}
        type="button"
        transition={transition}
        aria-label={
          expanded ? '收起任务状态' : `展开任务状态：${event.label}，${getTaskStatusText(event)}`
        }
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        <span className="task-island-state" aria-hidden="true">
          <TaskStateGlyph state={state} />
        </span>
        <span className="task-island-copy">
          <b>{event.label}</b>
          <small>{getTaskStatusText(event)}</small>
        </span>
        {otherActiveTaskCount > 0 && (
          <span className="task-island-count">+{otherActiveTaskCount}</span>
        )}
      </motion.button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="task-island-detail"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={transition}
          >
            <div className="task-island-detail-head">
              <span>
                {indeterminate
                  ? `已发现 ${event.completed} 项`
                  : `${event.completed}/${event.total}`}
              </span>
              {event.failed > 0 && <strong>失败 {event.failed}</strong>}
            </div>
            <div
              className="progress-track"
              aria-label={indeterminate ? '不定量处理进度' : `进度 ${percent}%`}
            >
              <div
                className={`progress-bar ${state} ${indeterminate ? 'indeterminate' : ''}`}
                style={{ width: indeterminate ? undefined : `${percent ?? 0}%` }}
              />
            </div>
            {terminal ? (
              <p>{getTaskResultText(event)}</p>
            ) : (
              (event.current || rateText || etaText) && (
                <p title={event.current}>
                  {event.current}
                  {(rateText || etaText) && (
                    <span> · {[rateText, etaText].filter(Boolean).join(' · ')}</span>
                  )}
                </p>
              )
            )}
            {terminal && (
              <div className="task-island-actions">
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new Event('task-center:open'))}
                >
                  打开任务队列
                </button>
                <button
                  type="button"
                  onClick={() => {
                    dismissTask(event.taskId)
                    setExpanded(false)
                    setPinnedTaskId(null)
                  }}
                >
                  关闭提示
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function TaskStateGlyph({
  state
}: {
  state: 'running' | 'success' | 'failed' | 'cancelled'
}): React.JSX.Element {
  if (state === 'success') return <span>✓</span>
  if (state === 'failed') return <span>!</span>
  if (state === 'cancelled') return <span>×</span>
  return <span className="task-island-pulse" />
}

export default TaskIsland
