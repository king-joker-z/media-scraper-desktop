declare module './scan.mjs' {
  import type { Comic, ComicMergedState, ComicScanResult } from '../../../shared/types'

  /** 读取合并清单（不存在/损坏/产物被删时返回 null） */
  export function readComicState(comicDir: string): Promise<ComicMergedState | null>

  /** 扫描单部漫画 */
  export function scanComic(root: string, relDir: string): Promise<Comic>

  /** 扫描漫画工作区：一级子文件夹逐部解析 */
  export function scanComicWorkspace(root: string): Promise<ComicScanResult>
}
