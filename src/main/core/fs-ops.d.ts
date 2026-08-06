declare module './fs-ops.mjs' {
  export function pathExists(target: string): Promise<boolean>
  export function permanentDelete(target: string): Promise<void>
  export function ensureUniquePath(target: string): Promise<string>
  export function moveWithCollision(from: string, toDir: string): Promise<string>
  export function renameWithCollision(from: string, newName: string): Promise<string>
  export function writeTextFile(target: string, content: string): Promise<string>
  export function removeEmptyDirs(root: string): Promise<string[]>
  export function isJunkFileName(name: string): boolean
}
