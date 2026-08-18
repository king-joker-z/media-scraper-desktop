declare module './merge.mjs' {
  import type { MediaInfo, MergeResult, MergeSourceItem } from '../../../shared/types'
  import type { TaskCenter } from '../../core/task-center.mjs'

  export function mergeWorkDir(
    items: {
      path: string
      media?: Pick<MediaInfo, 'sizeBytes' | 'durationMs'> | null
      sourceMtimeMs?: number
      sourceSizeBytes?: number
    }[],
    target: { width: number; height: number; fps: number; pixFmt: string } | null,
    encoder?: 'cpu' | 'nvenc' | 'cuda-nvenc',
    tempRoot?: string
  ): string

  export function mergeVideos(options: {
    items: { path: string; name: string; media: MediaInfo | null }[]
    outputDir: string
    outputName: string
    ffmpegPath: string
    ffprobePath: string
    onProgress?: (percent: number, stage: string) => void
    signal?: AbortSignal
    nvencEnabled?: boolean
    cudaPipelineEnabled?: boolean
    mergeTranscodeConcurrency?: number
    tempDirectory?: string
    probeNvenc?: (ffmpegPath: string) => Promise<{ available: boolean; reason?: string }>
    probeCudaPipeline?: (ffmpegPath: string) => Promise<{ available: boolean; reason?: string }>
    diskFree?: (dir: string) => Promise<number>
    volumeId?: (dir: string) => Promise<string | number>
    runFfmpegImpl?: (
      ffmpegPath: string,
      args: string[],
      options: { signal?: AbortSignal; onProgress?: (percent: number) => void; totalMs: number }
    ) => Promise<void>
  }): Promise<MergeResult>

  export function deleteMergeSources(
    root: string,
    items: MergeSourceItem[],
    options: {
      taskCenter: TaskCenter
      taskId: string
      concurrency?: number
      /** 删除实现（默认永久删除；主进程按设置注入回收站删除） */
      deleteFn?: (target: string) => Promise<void>
    }
  ): Promise<{
    cancelled: boolean
    deletedCount: number
    failed: { target: string; error: string }[]
  }>
}
