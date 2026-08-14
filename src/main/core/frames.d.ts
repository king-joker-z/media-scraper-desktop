declare module './frames.mjs' {
  export function resolveFfmpegPath(): string
  export function buildFrameTimestamps(durationMs: number, count?: number): number[]
  export function buildCaptureArgs(videoPath: string, seconds: number, targetPath: string): string[]
  /** 快速截帧参数：仅输入侧 -ss，候选封面等精度不敏感场景用 */
  export function buildFastCaptureArgs(
    videoPath: string,
    seconds: number,
    targetPath: string
  ): string[]
  export function detectSceneCuts(
    videoPath: string,
    options?: { ffmpegPath?: string; threshold?: number; limit?: number; signal?: AbortSignal }
  ): Promise<number[]>
  export function captureFrame(
    videoPath: string,
    seconds: number,
    targetPath: string,
    ffmpegPath?: string,
    options?: { signal?: AbortSignal; fast?: boolean }
  ): Promise<string>
  /** 单进程多帧截取参数 */
  export function buildMultiCaptureArgs(
    videoPath: string,
    jobs: Array<{ seconds: number; target: string }>
  ): string[]
  /** 逐帧批量截帧：单个时点失败会被剔除，全部失败才抛错。 */
  export function captureFrames(
    videoPath: string,
    jobs: Array<{ seconds: number; target: string }>,
    ffmpegPath?: string,
    options?: { signal?: AbortSignal }
  ): Promise<string[]>
}
