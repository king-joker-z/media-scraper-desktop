declare module './process-registry.mjs' {
  import type { ChildProcess } from 'node:child_process'

  export interface TrackOptions {
    signal?: AbortSignal
    /** abort 后 SIGTERM 的宽限期（毫秒），超时升级 SIGKILL，默认 800 */
    killGraceMs?: number
    /** Windows 下仅 ffmpeg 通过 stdin q 优雅收尾；其他子进程直接终止。 */
    gracefulQuit?: 'ffmpeg' | 'none'
  }

  /** 注册子进程并挂接生命周期清理（退出即移除引用，abort 时 TERM→KILL 兜底） */
  export function trackChild(child: ChildProcess, options?: TrackOptions): ChildProcess

  /** 当前活跃子进程数 */
  export function activeProcessCount(): number

  /** 兜底强杀全部活跃子进程（应用退出前调用） */
  export function killAllActiveProcesses(): void

  export interface SpawnOptions extends TrackOptions {
    onStdout?: (text: string) => void
    onStderr?: (text: string) => void
  }

  export interface SpawnResult {
    code: number | null
    signal: string | null
    cancelled: boolean
  }

  /** spawn 托管版：长进程/流式输出，进程自动注册管理 */
  export function spawnManaged(
    cmd: string,
    args: string[],
    options?: SpawnOptions
  ): Promise<SpawnResult>
}
