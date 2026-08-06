declare module './merge.mjs' {
  import type { MediaInfo, MergeResult, MergeSourceItem } from '../../../shared/types'
  import type { TaskCenter } from '../../core/task-center.mjs'

  export function mergeWorkDir(
    items: { path: string }[],
    target: { width: number; height: number; fps: number; pixFmt: string } | null
  ): string

  export function mergeVideos(options: {
    items: { path: string; name: string; media: MediaInfo | null }[]
    outputDir: string
    outputName: string
    ffmpegPath: string
    ffprobePath: string
    onProgress?: (percent: number, stage: string) => void
    signal?: AbortSignal
  }): Promise<MergeResult>

  export function deleteMergeSources(
    root: string,
    items: MergeSourceItem[],
    options: { taskCenter: TaskCenter; taskId: string; concurrency?: number }
  ): Promise<{
    cancelled: boolean
    deletedCount: number
    failed: { target: string; error: string }[]
  }>
}
