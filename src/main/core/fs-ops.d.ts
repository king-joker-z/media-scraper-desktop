declare module './fs-ops.mjs' {
  export interface MoveOptions {
    /** 拷贝进度回调（仅在跨设备流式复制时触发） */
    onProgress?: (copiedBytes: number, totalBytes: number) => void
    /** 取消信号（取消后删除不完整的目标副本） */
    signal?: AbortSignal
  }
  export function pathExists(target: string): Promise<boolean>
  export function permanentDelete(target: string): Promise<void>
  /** 注入回收站实现（主进程启动时调用） */
  export function setTrashImpl(fn: ((target: string) => Promise<void>) | null): void
  /** 删除到系统回收站；未注入或回收站不可用时回退永久删除 */
  export function deleteToTrash(target: string): Promise<void>
  /** 清理跨设备移动残留的 .msd-part 临时件，返回清理路径列表 */
  export function cleanMovePartials(dir: string): Promise<string[]>
  export function ensureUniquePath(target: string): Promise<string>
  export function moveFile(from: string, to: string, options?: MoveOptions): Promise<void>
  export function moveWithCollision(
    from: string,
    toDir: string,
    options?: MoveOptions
  ): Promise<string>
  export function dirSizeBytes(dir: string): Promise<number>
  export function renameWithCollision(
    from: string,
    newName: string,
    options?: MoveOptions
  ): Promise<string>
  export function writeTextFile(target: string, content: string): Promise<string>
  /** 读文本文件（utf8） */
  export function readTextFile(target: string): Promise<string>
  /** 读二进制文件（EPUB/PDF 等） */
  export function readBinaryFile(target: string): Promise<Buffer>
  /** 原子写入二进制文件（先 .part 后 rename） */
  export function writeBinaryFile(target: string, data: Uint8Array): Promise<void>
  export function removeEmptyDirs(root: string): Promise<string[]>
  export function isJunkFileName(name: string): boolean
  export function listDirNames(dir: string): Promise<string[]>
  export function directRename(from: string, to: string): Promise<string>
  export function diskFreeBytes(dir: string): Promise<number>
  export function ensureDir(dir: string): Promise<string>
}
