declare module './frames.mjs' {
  export function resolveFfmpegPath(): string
  export function buildFrameTimestamps(durationMs: number, count?: number): number[]
  export function buildCaptureArgs(videoPath: string, seconds: number, targetPath: string): string[]
  export function detectSceneCuts(
    videoPath: string,
    options?: { ffmpegPath?: string; threshold?: number; limit?: number }
  ): Promise<number[]>
  export function captureFrame(
    videoPath: string,
    seconds: number,
    targetPath: string,
    ffmpegPath?: string
  ): Promise<string>
}
