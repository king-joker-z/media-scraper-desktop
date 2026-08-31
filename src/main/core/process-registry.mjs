import { spawn } from 'node:child_process'

/**
 * 子进程注册表：所有 ffmpeg/ffprobe 进程必须经此模块创建并注册。
 * 解决的问题：
 * - 进程退出后立即从注册表移除并清理定时器/监听器，不留引用（防内存与句柄泄漏）；
 * - abort 时先 SIGTERM 给 ffmpeg 收尾机会（关闭输出文件），宽限期后仍未退出则 SIGKILL 兜底；
 * - 应用退出时 killAllActiveProcesses 兜底强杀，防孤儿进程死占 CPU/内存。
 */

const activeChildren = new Set()
/** abort 后 SIGTERM 的宽限期，超时升级 SIGKILL */
const KILL_GRACE_MS = 1500

/**
 * 注册子进程并挂接生命周期清理。
 * @param {import('node:child_process').ChildProcess} child
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.killGraceMs]
 * @param {'ffmpeg'|'none'} [options.gracefulQuit] Windows 下是否通过 stdin 发送 ffmpeg 的 q 命令
 */
export function trackChild(
  child,
  { signal, killGraceMs = KILL_GRACE_MS, gracefulQuit = 'none' } = {}
) {
  activeChildren.add(child)
  let killTimer = null
  const onAbort = () => {
    let gracefulGraceMs = killGraceMs
    if (process.platform === 'win32' && gracefulQuit === 'ffmpeg') {
      // Windows 上信号会退化为强杀；仅 ffmpeg 支持 stdin q 的跨平台优雅收尾。
      // 即使 stdin 管道已异常关闭，也要保留写入尾部索引的时间，不能 1.5 秒后强杀。
      gracefulGraceMs = Math.max(killGraceMs, 10_000)
      try {
        if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write('q')
          child.stdin.end()
        }
      } catch {
        // stdin 不可用时仍等待同样的宽限期，再由下方强杀兜底。
      }
    } else {
      try {
        child.kill('SIGTERM')
      } catch {
        // 进程已退出
      }
    }
    killTimer = setTimeout(() => {
      if (activeChildren.has(child) && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // 进程已退出
        }
      }
    }, gracefulGraceMs)
    killTimer.unref?.()
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const cleanup = () => {
    activeChildren.delete(child)
    if (killTimer) clearTimeout(killTimer)
    signal?.removeEventListener('abort', onAbort)
  }
  child.once('close', cleanup)
  child.once('error', cleanup)
  return child
}

/** 当前活跃子进程数（退出前收尾判断用） */
export function activeProcessCount() {
  return activeChildren.size
}

/** 兜底强杀全部活跃子进程（应用退出前调用） */
export function killAllActiveProcesses() {
  for (const child of [...activeChildren]) {
    try {
      child.kill('SIGKILL')
    } catch {
      // 进程已退出
    }
    activeChildren.delete(child)
  }
}

/**
 * spawn 托管版：长进程/流式输出场景，onStdout/onStderr 持续消费防缓冲堆积。
 * @returns {Promise<{code: number | null, signal: string | null, cancelled: boolean}>}
 */
export function spawnManaged(
  cmd,
  args,
  { signal, onStdout, onStderr, killGraceMs, gracefulQuit = 'none' } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    trackChild(child, { signal, killGraceMs, gracefulQuit })
    child.stdout?.on('data', (chunk) => onStdout?.(chunk.toString()))
    child.stderr?.on('data', (chunk) => onStderr?.(chunk.toString()))
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      fn(value)
    }
    const onError = (error) => finish(reject, error)
    const onClose = (code, signalName) =>
      finish(resolve, { code, signal: signalName, cancelled: Boolean(signal?.aborted) })
    child.once('error', onError)
    child.once('close', onClose)
  })
}
