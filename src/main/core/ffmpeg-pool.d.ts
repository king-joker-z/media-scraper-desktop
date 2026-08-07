declare module './ffmpeg-pool.mjs' {
  export interface ExecResult {
    stdout: string
    stderr: string
  }

  export interface PoolExecOptions {
    signal?: AbortSignal
    maxBuffer?: number
    killGraceMs?: number
  }

  /** 设置池大小（运行时动态调整） */
  export function setPoolSize(size: number): void

  /** 当前池大小 */
  export function getPoolSize(): number

  /** 当前活跃进程数 */
  export function getActiveCount(): number

  /** 当前排队等待数 */
  export function getPendingCount(): number

  /** 获取一个执行许可（池未满时立即返回，否则排队等待） */
  export function acquire(): Promise<void>

  /** 释放许可并唤醒队首等待者 */
  export function release(): void

  /** 池限流的 execFile：获取许可后执行，完成后自动释放 */
  export function runPooled(
    cmd: string,
    args: string[],
    options?: PoolExecOptions
  ): Promise<ExecResult>
}
