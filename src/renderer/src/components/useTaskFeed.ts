import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskEvent } from '../../../shared/types'
import { isTerminalTask } from './task-display'

const MAX_HISTORY = 50

export interface TaskFeedItem {
  event: TaskEvent
  startedAt: number
  dismissed: boolean
}

export interface TaskFeed {
  tasks: TaskFeedItem[]
  activeTasks: TaskFeedItem[]
  historyTasks: TaskFeedItem[]
  events: TaskEvent[]
  dismissTask: (taskId: string) => void
  clearHistory: () => void
}

function compareTasks(left: TaskFeedItem, right: TaskFeedItem): number {
  const priority = (item: TaskFeedItem): number => {
    if (item.event.type === 'failed' || item.event.failed > 0) return 0
    if (item.event.type === 'cancelled') return 1
    if (!isTerminalTask(item.event)) return 2
    return 3
  }
  return priority(left) - priority(right) || right.event.at - left.event.at
}

export function useTaskFeed(): TaskFeed {
  const [items, setItems] = useState<Map<string, TaskFeedItem>>(new Map())
  const [events, setEvents] = useState<TaskEvent[]>([])
  const dismissedTaskIds = useRef(new Set<string>())
  const terminalTaskIds = useRef(new Set<string>())

  useEffect(() => {
    const unsubscribe = window.api.onTaskEvent((event) => {
      if (dismissedTaskIds.current.has(event.taskId)) return
      if (!isTerminalTask(event) && terminalTaskIds.current.has(event.taskId)) return

      setItems((previous) => {
        const next = new Map(previous)
        const existing = next.get(event.taskId)
        next.set(event.taskId, {
          event,
          startedAt: event.type === 'start' || !existing ? event.at : existing.startedAt,
          dismissed: false
        })
        return next
      })
      setEvents((previous) => [event, ...previous].slice(0, MAX_HISTORY))
      if (isTerminalTask(event)) terminalTaskIds.current.add(event.taskId)
    })
    return unsubscribe
  }, [])

  const dismissTask = useCallback((taskId: string): void => {
    dismissedTaskIds.current.add(taskId)
    terminalTaskIds.current.delete(taskId)
    setItems((previous) => {
      const next = new Map(previous)
      next.delete(taskId)
      return next
    })
  }, [])

  const clearHistory = useCallback((): void => {
    setItems((previous) => {
      const next = new Map(previous)
      for (const [taskId, item] of previous) {
        if (!isTerminalTask(item.event)) continue
        dismissedTaskIds.current.add(taskId)
        terminalTaskIds.current.delete(taskId)
        next.delete(taskId)
      }
      return next
    })
    setEvents([])
  }, [])

  const tasks = useMemo(() => [...items.values()].sort(compareTasks), [items])
  const activeTasks = useMemo(() => tasks.filter((task) => !isTerminalTask(task.event)), [tasks])
  const historyTasks = useMemo(() => tasks.filter((task) => isTerminalTask(task.event)), [tasks])

  return { tasks, activeTasks, historyTasks, events, dismissTask, clearHistory }
}
