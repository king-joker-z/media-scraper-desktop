declare module './scan.mjs' {
  import type { Comic, ComicMergedState, ComicScanResult } from '../../../shared/types'

  /** 读取合并清单（不存在/损坏/产物被删时返回 null） */
  export function readComicState(comicDir: string): Promise<ComicMergedState | null>

  /**
   * 扫描单部漫画。
   * @param options.light 为 true 时只统计各章节目录的直接图片（不递归子目录），
   *   用于重命名/删源后与自动刷新的快速刷新；合并/删源前必须使用全量扫描。
   */
  export function scanComic(
    root: string,
    relDir: string,
    options?: { light?: boolean }
  ): Promise<Comic>

  /** 扫描漫画工作区：一级子文件夹逐部解析（options.light 同 scanComic） */
  export function scanComicWorkspace(
    root: string,
    options?: { light?: boolean }
  ): Promise<ComicScanResult>
}
