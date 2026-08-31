declare module './scan.mjs' {
  import type { Comic, ComicMergedState, ComicScanResult } from '../../../shared/types'

  export const COMIC_STATE_PENDING_NAME: string
  /** 读取合并清单（不存在/损坏/产物被删时返回 null） */
  export function readComicState(comicDir: string): Promise<ComicMergedState | null>
  /** 恢复产物已提交、清单尚未落盘的漫画事务。 */
  export function recoverComicStateTransaction(comicDir: string): Promise<boolean>

  /**
   * 扫描单部漫画。
   * 嵌套目录也会完整递归，保证章节差异判断准确。
   */
  export function scanComic(
    root: string,
    relDir: string,
    options?: { signal?: AbortSignal }
  ): Promise<Comic>

  /** 扫描漫画工作区：一级子文件夹逐部解析。 */
  export function scanComicWorkspace(
    root: string,
    options?: { signal?: AbortSignal }
  ): Promise<ComicScanResult>
}
