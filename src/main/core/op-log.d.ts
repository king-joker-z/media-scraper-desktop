declare module './op-log.mjs' {
  import type { OpLogDetail, OpLogSummary, UndoReport } from '../../shared/types'

  export const OP_LOG_KEEP: number
  export function pruneOpLogs(dir: string, keep?: number): Promise<number>
  export function writeOpLog(dir: string, module: string, payload: object): Promise<string>
  export interface OpLogContent {
    module?: string
    root?: string
    undoneAt?: string
    report?: {
      items?: { from: string; to: string }[]
      archived?: unknown[]
      [key: string]: unknown
    }
    lastUndoAttempt?: UndoReport
    [key: string]: unknown
  }
  export function readOpLog(file: string): Promise<OpLogContent | null>
  export function markOpLogUndoAttempt(
    file: string,
    log: OpLogContent,
    report: UndoReport,
    completed: boolean
  ): Promise<void>
  export function getOpLogDetail(dir: string, file: string): Promise<OpLogDetail | null>
  export function listOpLogs(dir: string, limit?: number): Promise<OpLogSummary[]>
}
