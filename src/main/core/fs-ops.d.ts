declare module './fs-ops.mjs' {
  export function pathExists(target: string): Promise<boolean>
  export function permanentDelete(target: string): Promise<void>
  export function ensureUniquePath(target: string): Promise<string>
  export function moveFile(from: string, to: string): Promise<void>
  export function moveWithCollision(from: string, toDir: string): Promise<string>
  export function dirSizeBytes(dir: string): Promise<number>
  export function renameWithCollision(from: string, newName: string): Promise<string>
  export function writeTextFile(target: string, content: string): Promise<string>
  export function removeEmptyDirs(root: string): Promise<string[]>
  export function isJunkFileName(name: string): boolean
  export function listDirNames(dir: string): Promise<string[]>
  export function directRename(from: string, to: string): Promise<string>
  export function diskFreeBytes(dir: string): Promise<number>
  export function ensureDir(dir: string): Promise<string>
}
