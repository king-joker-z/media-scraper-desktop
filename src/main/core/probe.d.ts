declare module './probe.mjs' {
  import type { MediaInfo } from '../../shared/types'

  export function resolveFfprobePath(): string
  export function parseFrameRate(rate: unknown): number
  export function parseProbeJson(raw: unknown): MediaInfo
  export function probeMedia(filePath: string, ffprobePath?: string): Promise<MediaInfo>
  export function probeMediaCached(
    filePath: string,
    ffprobePath?: string,
    probeFn?: (filePath: string, ffprobePath: string) => Promise<MediaInfo>
  ): Promise<MediaInfo>
  export function clearProbeCache(): void
}
