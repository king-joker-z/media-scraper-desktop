declare module './ffmpeg-pool.mjs' {
  export interface ExecResult {
    stdout: string
    stderr: string
  }

  export interface PoolExecOptions {
    signal?: AbortSignal
    maxBuffer?: number
    killGraceMs?: number
    gracefulQuit?: 'ffmpeg' | 'none'
  }

  /** 设置池大小（运行时动态调整） */
  export function setPoolSize(size: number): void

  /** 当前池大小 */
  export function getPoolSize(): number

  /** 当前活跃进程数 */
  export function getActiveCount(): number

  /** 当前排队等待数 */
  export function getPendingCount(): number

  /** 单个 ffmpeg 进程的线程预算（按当前池大小均分核数，下限 2） */
  export function getThreadBudget(): number

  /** 获取一个执行许可（池未满时立即返回，否则排队等待；signal 取消即时出队） */
  export function acquire(options?: { signal?: AbortSignal }): Promise<void>

  /** 释放许可并唤醒队首等待者 */
  export function release(): void

  /** 池限流的 execFile：获取许可后执行，完成后自动释放 */
  export function runPooled(
    cmd: string,
    args: string[],
    options?: PoolExecOptions
  ): Promise<ExecResult>

  export interface PoolSpawnOptions {
    signal?: AbortSignal
    onStdout?: (text: string) => void
    onStderr?: (text: string) => void
    killGraceMs?: number
    gracefulQuit?: 'ffmpeg' | 'none'
  }

  export interface SpawnResult {
    code: number | null
    signal: string | null
    cancelled: boolean
  }

  /** 池限流的 spawn：长进程/流式输出与 runPooled 共用同一许可池 */
  export function spawnPooled(
    cmd: string,
    args: string[],
    options?: PoolSpawnOptions
  ): Promise<SpawnResult>
}
