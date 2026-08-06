declare module './execute.mjs' {
  import type { RenamePairInput, RenameReport } from '../../../shared/types'
  import type { TaskCenter } from '../../core/task-center.mjs'

  export function executeRename(
    root: string,
    pairs: RenamePairInput[],
    options: { taskCenter: TaskCenter; taskId: string; concurrency?: number }
  ): Promise<RenameReport>
}
