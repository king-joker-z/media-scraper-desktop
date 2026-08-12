declare module './rename.mjs' {
  import type { TaskCenter } from '../../core/task-center.mjs'

  export function renameComicDirectories(
    root: string,
    items: Array<{ relDir: string; newName: string }>,
    options: { taskCenter: TaskCenter; taskId: string; concurrency?: number }
  ): Promise<{
    taskId: string
    cancelled: boolean
    renamedCount: number
    items: Array<{ from: string; to: string }>
    failed: Array<{ target: string; error: string }>
  }>
}
