declare module './dedupe.mjs' {
  import type { TaskCenter } from '../../core/task-center.mjs'

  export interface DupGroupItem {
    relativePath: string
    name: string
    dir: string
    size: number
  }

  export interface DupGroup {
    hash: string
    sizeBytes: number
    items: DupGroupItem[]
  }

  export function findDuplicates(
    root: string,
    options?: { taskCenter?: TaskCenter; taskId?: string; concurrency?: number }
  ): Promise<DupGroup[]>
}
