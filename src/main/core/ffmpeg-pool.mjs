import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { spawnManaged, trackChild } from './process-registry.mjs'

/**
 * FFmpeg/FFprobe 进程池：
 *
 * 问题：TaskCenter 的并发控制（默认 5）只限制 worker 数，但每个 worker 内部可能
 * 再 spawn 子进程（如截帧时先 detectSceneCuts 再 captureFrame，最多 3 路帧级并发），
 * 导致实际 ffmpeg 进程数 = 并发 × 帧级并发 = 15+，打满 CPU。
 *
 * 方案：全局信号量限流 + 短任务执行器。
 * - acquire() 获取许可（阻塞直到有空位），release() 释放；
 * - runPooled() 自动获取/释放，执行 execFile 并返回结果；
 * - 池大小默认 4（独立于 TaskCenter 并发，专门控制 ffmpeg 进程数）。
 *
 * 注意：ffmpeg/ffprobe 不支持交互式 pipe 复用（每次执行完即退出），
 * 因此"池化"在此场景下是进程数限流 + 减少启动竞争，而非长进程复用。
 */

// 默认池大小按核数自适应：低配机（≤4 核）降到 2，避免 N 个进程 × 每进程全核线程
// 的超订把 Windows 低配机 CPU/磁盘打满；高配机维持上限 4。用户仍可在设置页覆盖。
const DEFAULT_POOL_SIZE = Math.min(4, Math.max(2, Math.floor(cpus().length / 2)))

let poolSize = DEFAULT_POOL_SIZE
let activeCount = 0
// 等待者：{ wake, onAbort }——onAbort 挂到调用方 AbortSignal 上，取消即时出队，
// 避免任务取消后排队的 ffmpeg 仍被逐个唤醒执行（取消传播不到池等待者的问题）
const waitQueue = []

const newAbortError = () => {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

/**
 * 设置池大小（运行时动态调整）。
 * 缩小时不会中断在途任务，只是不再分配新许可直到 active < newSize。
 */
export function setPoolSize(size) {
  poolSize = Math.max(1, Math.round(size))
  // 扩容后唤醒等待者
  drainQueue()
}

export function getPoolSize() {
  return poolSize
}

export function getActiveCount() {
  return activeCount
}

export function getPendingCount() {
  return waitQueue.length
}

/**
 * 单个 ffmpeg 进程的线程预算：按当前池大小均分核数（下限 2）。
 * 用于给转码命令传 -threads / -filter_threads，防止「池大小 × 每进程全核线程」
 * 的线程超订。池大小运行时变化时，下一次调用自动按新池大小计算。
 */
export function getThreadBudget() {
  return Math.max(2, Math.ceil(cpus().length / poolSize))
}

/**
 * 获取一个执行许可（池未满时立即返回，否则排队等待）。
 * 传入 signal 时：已取消立即 reject AbortError；排队期间取消即时出队并 reject。
 */
export function acquire({ signal } = {}) {
  if (signal?.aborted) return Promise.reject(newAbortError())
  if (activeCount < poolSize) {
    activeCount += 1
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const waiter = { wake: null, onAbort: null }
    waiter.wake = () => {
      if (waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort)
      resolve()
    }
    if (signal) {
      waiter.onAbort = () => {
        const index = waitQueue.indexOf(waiter)
        if (index >= 0) waitQueue.splice(index, 1)
        reject(newAbortError())
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    }
    waitQueue.push(waiter)
  })
}

/** 释放许可并唤醒队首等待者 */
export function release() {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()
    next.wake()
    // 不增不减：许可从释放者传递给等待者
    return
  }
  activeCount = Math.max(0, activeCount - 1)
}

/** 尝试唤醒等待队列中的任务（池扩容后调用） */
function drainQueue() {
  while (activeCount < poolSize && waitQueue.length > 0) {
    const next = waitQueue.shift()
    activeCount += 1
    next.wake()
  }
}

/**
 * 池限流的 execFile：获取许可后执行，完成后释放。
 * 与 execManaged 接口一致（收集 stdout/stderr、signal 可取消、进程注册管理）。
 */
export function runPooled(
  cmd,
  args,
  { signal, maxBuffer = 16 * 1024 * 1024, killGraceMs, gracefulQuit = 'none' } = {}
) {
  return acquire({ signal }).then(() => {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = execFile(cmd, args, { maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
          release()
          if (error) {
            if (signal?.aborted) {
              const abortError = new Error('已取消')
              abortError.name = 'AbortError'
              reject(abortError)
              return
            }
            error.stderrTail = typeof stderr === 'string' ? stderr.slice(-2000) : ''
            reject(error)
            return
          }
          resolve({ stdout: String(stdout), stderr: String(stderr) })
        })
      } catch (error) {
        release()
        reject(error)
        return
      }
      trackChild(child, { signal, killGraceMs, gracefulQuit })
    })
  })
}

/**
 * 池限流的 spawn（流式输出场景：合并转码 / 体检全量解码）。
 * 与 runPooled 共用同一许可池，保证「同时运行的 ffmpeg 进程数 ≤ 池大小」
 * 对所有执行路径一致成立；排队等待同样响应 signal 取消。
 */
export async function spawnPooled(
  cmd,
  args,
  { signal, onStdout, onStderr, killGraceMs, gracefulQuit = 'none' } = {}
) {
  await acquire({ signal })
  try {
    return await spawnManaged(cmd, args, {
      signal,
      onStdout,
      onStderr,
      killGraceMs,
      gracefulQuit
    })
  } finally {
    release()
  }
}
