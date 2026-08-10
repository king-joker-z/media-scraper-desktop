declare module './task-center.mjs' {
  import type { TaskEvent } from '../../shared/types'

  export const MIN_CONCURRENCY: 1
  export const MAX_CONCURRENCY: 20
  export const DEFAULT_CONCURRENCY: 5
  export function clampConcurrency(value: unknown): number

  export interface TaskResult<T = unknown> {
    cancelled: boolean
    completed: number
    failed: number
    results: ({ ok: true; value: T } | { ok: false; error?: string; cancelled?: boolean })[]
  }

  export interface RunOptions<T = unknown, R = unknown> {
    taskId: string
    label: string
    items: T[]
    worker: (item: T, signal: AbortSignal) => Promise<R>
    concurrency?: number
    /** 外部取消信号，会联动取消该任务的内部调度器 */
    signal?: AbortSignal
  }

  export interface TaskCenter {
    run<T = unknown, R = unknown>(options: RunOptions<T, R>): Promise<TaskResult<R>>
    cancel(taskId: string): void
    cancelAll(): void
    hasActive(): boolean
  }

  export function createTaskCenter(options?: { emit?: (event: TaskEvent) => void }): TaskCenter
}
