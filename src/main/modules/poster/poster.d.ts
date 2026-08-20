declare module './poster.mjs' {
  import type { CandidateFrameScore, PosterVideoItem, ScanPlan } from '../../../shared/types'

  export function mapPosterVideos(plan: ScanPlan): PosterVideoItem[]
  export function listPosterVideos(
    root: string,
    options?: { onProgress?: (scanned: number) => void; concurrency?: number }
  ): Promise<PosterVideoItem[]>
  /** 轻量质量评分：灰度缩略图的清晰度、纯色比例、亮度与对比度 */
  export function scoreCandidateFrame(framePath: string): Promise<CandidateFrameScore>
  export function rankCandidateFrames(framePaths: string[]): Promise<CandidateFrameScore[]>
  /** 为候选分配仅供接触表浏览的视觉相似组。 */
  export function assignSimilarityGroups(scores: CandidateFrameScore[]): CandidateFrameScore[]
  export function framesDirFor(framesRoot: string, videoPath: string): string
  export function captureCandidates(
    videoPath: string,
    framesRoot: string,
    options?: { ffmpegPath?: string; ffprobePath?: string; signal?: AbortSignal; precise?: boolean }
  ): Promise<CandidateFrameScore[]>
  export function captureAt(
    videoPath: string,
    seconds: number,
    framesRoot: string,
    options?: { ffmpegPath?: string; signal?: AbortSignal }
  ): Promise<string>
  export function savePoster(options: {
    videoPath: string
    chosenFramePath: string
    oldPosterPath?: string | null
    deleteFn?: (target: string) => Promise<void>
    signal?: AbortSignal
  }): Promise<{ saved: string; deletedOld: string[] }>
  export function cleanupFrames(framesRoot: string, videoPath?: string): Promise<void>
  export function videoStem(videoPath: string): string
  export function computePendingSaves(
    videos: PosterVideoItem[],
    selections: Record<string, string>
  ): {
    relativePath: string
    videoPath: string
    chosenFramePath: string
    oldPosterPath: string | null
  }[]
}
