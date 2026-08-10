import { watch } from 'node:fs'

/**
 * 目录变化监控（F4）：递归 fs.watch + 尾随防抖。
 * 变化静默 debounceMs 后触发一次 onChange；监控本身不读取文件内容。
 * 递归监控依赖平台支持（macOS/Windows 可用；Linux 不支持时会走 onError）。
 *
 * @param {string} root 被监控目录
 * @param {object} options
 * @param {number} options.debounceMs 防抖毫秒数
 * @param {() => void} options.onChange 静默期结束后的回调
 * @param {(error: Error) => void} [options.onError] 监控失败回调
 * @returns {{ close: () => void }}
 */
export function watchDirectory(root, { debounceMs, onChange, onError }) {
  let timer = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(
      () => {
        timer = null
        onChange()
      },
      Math.max(1000, debounceMs)
    )
  }

  let watcher
  try {
    watcher = watch(root, { recursive: true }, schedule)
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)))
    return { close: () => {} }
  }
  watcher.on('error', (error) => onError?.(error))

  return {
    close() {
      if (timer) clearTimeout(timer)
      timer = null
      watcher.close()
    }
  }
}
