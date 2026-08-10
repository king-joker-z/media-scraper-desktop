declare module './path-guard.mjs' {
  /** 解析并校验相对路径位于 root 内 */
  export function resolveInsideRoot(root: string, relativePath: string): string
  /** 校验文件名不含目录或绝对路径 */
  export function assertSafeFileName(name: string): string
  /** 校验 IPC 请求使用当前登记的工作区 */
  export function assertRegisteredRoot(
    root: string,
    registeredRoot: string | null,
    label?: string
  ): string
}
