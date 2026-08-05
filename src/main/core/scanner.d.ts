declare module './scanner.mjs' {
  export const VIDEO_EXTENSIONS: Set<string>
  export const IMAGE_EXTENSIONS: Set<string>
  export function isHiddenName(name: string): boolean
  export function classifyPath(path: string): 'video' | 'image' | 'other'
  export function normalizedName(path: string): string
  export function createScanPlan(root: string): Promise<import('../../shared/types').ScanPlan>
}
