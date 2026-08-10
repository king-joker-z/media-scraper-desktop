declare module './dir-watch.mjs' {
  export interface WatchOptions {
    debounceMs: number
    onChange: () => void
    onError?: (error: Error) => void
  }
  /** 递归监控目录变化（尾随防抖），返回可关闭的句柄 */
  export function watchDirectory(root: string, options: WatchOptions): { close: () => void }
}
