declare module './epub.mjs' {
  /** EPUB 页面：优化模式统一 jpg；原样模式可保留 png/webp/gif */
  export interface EpubPage {
    data: Uint8Array
    width: number
    height: number
    ext: string
  }
  export interface EpubChapter {
    name: string
    pages: EpubPage[]
  }

  /** 新建 EPUB（一图一页 + 章节导航），返回 zip 字节 */
  export function createEpub(input: { title: string; chapters: EpubChapter[] }): Uint8Array

  /** 增量追加：新章节页码续编，原页面字节级保留 */
  export function appendEpub(
    existingBytes: Uint8Array,
    input: {
      title: string
      existingChapters: { name: string; pageCount: number }[]
      newChapters: EpubChapter[]
    }
  ): Uint8Array

  /** 读取 EPUB 内页面数（测试与校验用） */
  export function countEpubPages(bytes: Uint8Array): number

  /** 读取 EPUB 章节导航条目（测试用） */
  export function listEpubNavItems(bytes: Uint8Array): string[]
}
