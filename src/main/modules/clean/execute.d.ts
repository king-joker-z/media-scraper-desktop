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
    }
  ): Promise<CleanReport>
}
