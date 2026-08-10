declare module './task-report.mjs' {
  export interface TaskRunEntry {
    ok: boolean
    cancelled?: boolean
    error?: string
    value?: unknown
  }
  export interface TaskRunResult {
    cancelled: boolean
    completed: number
    failed: number
    results: TaskRunEntry[]
  }
  export function collectFailures(
    report: { failed: { target: string; error: string }[] },
    result: TaskRunResult,
    items: unknown[],
    key?: string
  ): void
  export function finishReport<T extends { cancelled: boolean; durationMs: number }>(
    report: T,
    startedAt: number,
    cancelled: boolean
  ): T
}
