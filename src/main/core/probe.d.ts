declare module './probe.mjs' {
  import type { MediaInfo } from '../../shared/types'

  export function resolveFfprobePath(): string
  export function parseFrameRate(rate: unknown): number
  export function parseProbeJson(raw: unknown): MediaInfo
  export function probeMedia(filePath: string, ffprobePath?: string): Promise<MediaInfo>
}
