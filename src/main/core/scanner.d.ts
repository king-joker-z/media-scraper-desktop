declare module './scanner.mjs' {
  import type { KeepItem, MoveItem, ScanPlan } from '../../shared/types'

  export const VIDEO_EXTENSIONS: Set<string>
  export const IMAGE_EXTENSIONS: Set<string>
  export function isHiddenName(name: string): boolean
  export function classifyPath(path: string): 'video' | 'image' | 'other'
  export function normalizedName(path: string): string
  export function posterFinalName(videoRelativePath: string): string
  export function predictMoves(keep: KeepItem[], skippedHidden: string[]): MoveItem[]
  export interface ScanOptions {
    onProgress?: (scanned: number) => void
    /** 子目录并发遍历数（默认 4，大目录树可适当调高） */
    concurrency?: number
  }
  export function createScanPlan(root: string, options?: ScanOptions): Promise<ScanPlan>
  export function computeFingerprint(root: string, options?: ScanOptions): Promise<string>
  export function invalidateScanCache(): void
}
