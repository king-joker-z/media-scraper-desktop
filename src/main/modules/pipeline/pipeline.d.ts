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
    }
  ): Promise<PipelineReport>
}
