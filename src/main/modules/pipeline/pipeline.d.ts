declare module './pipeline.mjs' {
  import type { PipelineStep, PipelineReport } from '../../../shared/types'
  import type { TaskCenter } from '../../core/task-center.mjs'

  export function runPipeline(
    root: string,
    steps: PipelineStep[],
    options: {
      taskCenter: TaskCenter
      concurrency?: number
      onStepStart?: (step: PipelineStep) => void
      onStepDone?: (result: PipelineReport['results'][number]) => void
      signal?: AbortSignal
      /** 删除实现（默认永久删除；主进程按设置注入回收站删除） */
      deleteFn?: (target: string) => Promise<void>
      /** 自动监控模式下禁用 clean/dedupe 的破坏性写入 */
      allowDestructive?: boolean
    }
  ): Promise<PipelineReport>
}
