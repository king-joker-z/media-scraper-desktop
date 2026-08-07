declare module './execute.mjs' {
  import type { CleanReport, PosterPicks, ScanPlan } from '../../../shared/types'
  import type { TaskCenter } from '../../core/task-center.mjs'

  export function executeCleanPlan(
    plan: ScanPlan,
    options: {
      picks?: PosterPicks
      taskCenter: TaskCenter
      taskId: string
      concurrency?: number
      /** 上移阶段跨磁盘拷贝进度文案回调，用于更新 TaskEvent.current */
      onMoveProgress?: (text: string) => void
    }
  ): Promise<CleanReport>
}
