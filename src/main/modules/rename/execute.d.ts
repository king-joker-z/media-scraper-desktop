declare module './execute.mjs' {
  import type { RenamePairInput, RenameReport } from '../../../shared/types'
  import type { TaskCenter } from '../../core/task-center.mjs'

  export function executeRename(
    root: string,
    pairs: RenamePairInput[],
    options: {
      taskCenter: TaskCenter
      taskId: string
      concurrency?: number
      /** 崩溃恢复 journal 路径（写入/收尾由执行器负责） */
      journalPath?: string
    }
  ): Promise<RenameReport>

  /** 按 journal 续跑残留临时文件到目标名；无 journal 返回 null */
  export function recoverRenameJournal(
    journalPath: string
  ): Promise<{ recovered: number; skipped: number } | null>
}
