declare module './rename.mjs' {
  import type { TaskCenter } from '../../core/task-center.mjs'

  export function renameComicDirectories(
    root: string,
    items: Array<{ relDir: string; newName: string }>,
    options: {
      taskCenter: TaskCenter
      taskId: string
      concurrency?: number
      /** 暂存/恢复/回退阶段的进度上报（发生在 TaskCenter 派发前/后） */
      onStageProgress?: (completed: number, total: number, current: string) => void
    }
  ): Promise<{
    taskId: string
    cancelled: boolean
    renamedCount: number
    items: Array<{ from: string; to: string }>
    failed: Array<{ target: string; error: string }>
  }>
}
