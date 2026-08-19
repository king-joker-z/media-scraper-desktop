import type { TaskEvent } from '../../../shared/types'

export const isTerminalTask = (event: TaskEvent): boolean =>
  event.type === 'done' || event.type === 'failed' || event.type === 'cancelled'

export type TaskVisualState = 'running' | 'success' | 'failed' | 'cancelled'

export function getTaskVisualState(event: TaskEvent): TaskVisualState {
  if (event.type === 'failed') return 'failed'
  if (event.type === 'cancelled') return 'cancelled'
  if (event.type === 'done') return 'success'
  return 'running'
}

export function isIndeterminateTask(event: TaskEvent): boolean {
  return event.total === 0 && !isTerminalTask(event)
}

export function getTaskPercent(event: TaskEvent): number | null {
  if (event.total <= 0) return null
  return Math.min(100, Math.max(0, Math.round((event.completed / event.total) * 100)))
}

export function getTaskRate(event: TaskEvent, startedAt: number): number {
  const elapsedMs = Math.max(0, event.at - startedAt)
  return elapsedMs > 0 && event.completed > 0 ? event.completed / (elapsedMs / 1000) : 0
}

export function formatTaskRate(rate: number): string {
  return rate >= 0.1 ? `${rate.toFixed(rate >= 10 ? 0 : 1)} 项/秒` : ''
}

export function formatTaskEta(event: TaskEvent, startedAt: number): string {
  const rate = getTaskRate(event, startedAt)
  if (rate <= 0 || event.total <= event.completed) return ''
  const seconds = Math.ceil((event.total - event.completed) / rate)
  return `约剩余 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function getTaskStatusText(event: TaskEvent): string {
  if (event.type === 'cancelled') return '停止派发新任务，正在收尾在途项'
  if (event.type === 'failed') return event.error || '执行失败'
  if (event.type === 'done')
    return `完成 ${event.completed}/${event.total}${event.failed ? `，失败 ${event.failed}` : ''}`
  if (isIndeterminateTask(event)) return `正在扫描，已发现 ${event.completed} 项`
  return `${event.completed}/${event.total}`
}

export function getTaskResultText(event: TaskEvent): string {
  if (event.type === 'cancelled') return `已请求取消，已完成 ${event.completed} 项`
  if (event.type === 'failed') return event.error || '执行失败，请查看原因后重试'
  if (event.type === 'done')
    return `完成 ${event.completed} 项${event.failed ? `，失败 ${event.failed} 项` : ''}`
  return getTaskStatusText(event)
}
