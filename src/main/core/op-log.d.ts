declare module './op-log.mjs' {
  export const OP_LOG_KEEP: number
  export function pruneOpLogs(dir: string, keep?: number): Promise<number>
  export function writeOpLog(dir: string, module: string, payload: object): Promise<string>
  /** 日志 JSON 内容（结构随模块 payload 变化，仅约定少量公共字段） */
  export interface OpLogContent {
    module?: string
    root?: string
    undoneAt?: string
    report?: {
      items?: { from: string; to: string }[]
      archived?: unknown[]
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  /** 读取单份日志完整内容；不存在/损坏返回 null */
  export function readOpLog(file: string): Promise<OpLogContent | null>
  /** 回写 undoneAt 标记（一键撤销成功后防重复撤销） */
  export function markOpLogUndone(file: string, log: OpLogContent): Promise<void>
  export function listOpLogs(
    dir: string,
    limit?: number
  ): Promise<
    {
      file: string
      module: string
      finishedAt: string
      summary: string
      undone: boolean
      undoable: boolean
    }[]
  >
}
