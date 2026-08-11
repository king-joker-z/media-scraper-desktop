declare module './media-path.mjs' {
  /** media:// URL 解码后的路径 → 本地文件路径（盘符/UNC/路径穿越归一） */
  export function mediaUrlPathToLocal(decoded: string): string
  /** 白名单比较用归一化：正斜杠、去尾部分隔符，Windows 盘符与 UNC 路径不区分大小写 */
  export function normalizeMediaPath(p: string): string
  /** 目标路径是否落在任一允许根内 */
  export function isMediaPathAllowed(filePath: string, roots: string[]): boolean
}
