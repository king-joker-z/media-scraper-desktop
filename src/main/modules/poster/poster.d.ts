declare module './poster.mjs' {
  import type { PosterVideoItem, ScanPlan } from '../../../shared/types'

  export function mapPosterVideos(plan: ScanPlan): PosterVideoItem[]
  export function listPosterVideos(root: string): Promise<PosterVideoItem[]>
  export function framesDirFor(framesRoot: string, videoPath: string): string
  export function captureCandidates(
    videoPath: string,
    framesRoot: string,
    options?: { ffmpegPath?: string; ffprobePath?: string }
  ): Promise<string[]>
  export function captureAt(
    videoPath: string,
    seconds: number,
    framesRoot: string,
    options?: { ffmpegPath?: string }
  ): Promise<string>
  export function savePoster(options: {
    videoPath: string
    chosenFramePath: string
    oldPosterPath?: string | null
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
