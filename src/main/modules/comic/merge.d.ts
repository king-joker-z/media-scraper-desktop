declare module './merge.mjs' {
  import type { ComicMergeItem, ComicMergeReport } from '../../../shared/types'
  import type { TaskCenter } from '../../core/task-center.mjs'

  /** 合并单部漫画（全量或增量自动判定；rebuild 强制全量重建） */
  export function mergeOneComic(
    root: string,
    relDir: string,
    options: {
      format: 'epub' | 'pdf'
      raw?: boolean
      rebuild?: boolean
      signal?: AbortSignal
      onProgress?: (progress: {
        completedPages: number
        totalPages: number
        current?: string
      }) => void
    }
  ): Promise<ComicMergeItem>

  /** 批量合并（TaskCenter 并发，一项一部漫画） */
  export function mergeComics(
    root: string,
    options: {
      relDirs: string[]
      format: 'epub' | 'pdf'
      raw?: boolean
      rebuild?: boolean
      taskCenter: TaskCenter
      taskId: string
      concurrency?: number
      onProgress?: (progress: {
        completed: number
        total: number
        current: string
        done?: boolean
        cancelled?: boolean
      }) => void
    }
  ): Promise<ComicMergeReport>

  /** 删除已合并漫画的源图片并清理空章节目录（产物/清单/封面保留） */
  export function deleteComicSources(
    root: string,
    options: {
      relDirs: string[]
      taskCenter: TaskCenter
      taskId: string
      concurrency?: number
      deleteFn: (target: string) => Promise<void>
    }
  ): Promise<{
    cancelled: boolean
    deletedCount: number
    failed: { target: string; error: string }[]
  }>
}
