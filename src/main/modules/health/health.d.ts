declare module './health.mjs' {
  import type { TaskCenter } from '../../core/task-center.mjs'
  import type { HealthReport } from '../../../shared/types'

  export interface IntegrityResult {
    ok: boolean
    error?: string
    cancelled?: boolean
  }

  export function checkVideoIntegrity(
    filePath: string,
    ffmpegPath: string,
    signal?: AbortSignal
  ): Promise<IntegrityResult>

  export function healthScan(
    root: string,
    options?: {
      taskCenter?: TaskCenter
      taskId?: string
      concurrency?: number
      ffmpegPath?: string
    }
  ): Promise<HealthReport>
}
