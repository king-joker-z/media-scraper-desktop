declare module './scanner.mjs' {
  import type { KeepItem, MoveItem, PlanRisk, ScanPlan } from '../../shared/types'

  export const VIDEO_EXTENSIONS: Set<string>
  export const IMAGE_EXTENSIONS: Set<string>
  export const DANGER_DELETE_COUNT: number
  export const DANGER_DELETE_BYTES: number
  export function isHiddenName(name: string): boolean
  export function classifyPath(path: string): 'video' | 'image' | 'other'
  export function normalizedName(path: string): string
  export function posterFinalName(videoRelativePath: string): string
  export function assessRisk(
    deleteItems: { size: number }[],
    videoCount: number
  ): { risk: PlanRisk; deleteBytes: number }
  export function predictMoves(keep: KeepItem[], skippedHidden: string[]): MoveItem[]
  export function createScanPlan(root: string): Promise<ScanPlan>
}
