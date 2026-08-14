declare module './execute.mjs' {
  import type { CleanReport, PosterPicks, ScanPlan } from '../../../shared/types'
  import type { TaskCenter } from '../../core/task-center.mjs'

  /** 仅上移可见文件并删除空目录，不执行删除、转码或 poster 标准化。 */
  export function executeDissolveFolders(
    plan: ScanPlan,
    options: {
      taskCenter: TaskCenter
      taskId: string
      concurrency?: number
      signal?: AbortSignal
      onMoveProgress?: (text: string) => void
    }
  ): Promise<CleanReport>
  export function executeCleanPlan(
    plan: ScanPlan,
    options: {
      picks?: PosterPicks
      taskCenter: TaskCenter
      taskId: string
      concurrency?: number
      signal?: AbortSignal
      /** 上移阶段跨磁盘拷贝进度文案回调，用于更新 TaskEvent.current */
      onMoveProgress?: (text: string) => void
      /** 删除实现（默认永久删除；主进程按设置注入回收站删除） */
      deleteFn?: (target: string) => Promise<void>
    }
  ): Promise<CleanReport>
}
