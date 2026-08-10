declare module './undo.mjs' {
  import type { UndoReport } from '../../../shared/types'
  import type { TaskCenter } from '../../core/task-center.mjs'

  /** 按操作日志一键撤销（rename/nfo），成功全部回退后标记日志 undoneAt */
  export function undoOpLog(
    file: string,
    options?: { taskCenter?: TaskCenter; taskId?: string; concurrency?: number }
  ): Promise<UndoReport>
}
