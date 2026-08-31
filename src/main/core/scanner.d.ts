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
    /** 全局目录遍历并发数（默认 4，任意目录深度共享此上限） */
    concurrency?: number
    /** 取消递归扫描；取消后 promise 以 AbortError 拒绝。 */
    signal?: AbortSignal
  }
  export function createScanPlan(root: string, options?: ScanOptions): Promise<ScanPlan>
  export function computeFingerprint(root: string, options?: ScanOptions): Promise<string>
  export function invalidateScanCache(): void
}
