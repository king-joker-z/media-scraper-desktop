declare module './dedupe.mjs' {
  import type { TaskCenter } from '../../core/task-center.mjs'
  import type { MediaInfo } from '../../../shared/types'

  export const SIMILAR_DURATION_TOLERANCE_MS: number
  export const SIMILAR_SIZE_RATIO_MIN: number

  export interface DupGroupItem {
    relativePath: string
    name: string
    dir: string
    size: number
    media: MediaInfo | null
  }

  export interface DupGroup {
    hash: string
    sizeBytes: number
    /** 建议保留项（质量最高）的 relativePath */
    keepRel: string
    items: DupGroupItem[]
  }

  export interface SimilarGroupItem extends DupGroupItem {
    /** 同指纹完全重复副本数（含自身），>1 表示还有完全相同的副本 */
    exactCopies: number
  }

  export interface SimilarGroup {
    /** 分辨率，如 "1920x1080" */
    key: string
    /** 建议保留项（体积最大 ≈ 码率最高）的 relativePath */
    keepRel: string
    items: SimilarGroupItem[]
  }

  export interface DedupeResult {
    exact: DupGroup[]
    similar: SimilarGroup[]
  }

  export function findDuplicates(
    root: string,
    options?: {
      taskCenter?: TaskCenter
      taskId?: string
      concurrency?: number
      ffprobePath?: string
      probeFn?: (path: string) => Promise<MediaInfo | null>
    }
  ): Promise<DedupeResult>
}
