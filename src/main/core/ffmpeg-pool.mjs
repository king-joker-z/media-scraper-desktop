import { execFile } from 'node:child_process'
import { trackChild } from './process-registry.mjs'

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

const DEFAULT_POOL_SIZE = 4

let poolSize = DEFAULT_POOL_SIZE
let activeCount = 0
const waitQueue = []

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

/** 获取一个执行许可（池未满时立即返回，否则排队等待） */
export function acquire() {
  if (activeCount < poolSize) {
    activeCount += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    waitQueue.push(resolve)
  })
}

/** 释放许可并唤醒队首等待者 */
export function release() {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()
    next()
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
    next()
  }
}

/**
 * 池限流的 execFile：获取许可后执行，完成后释放。
 * 与 execManaged 接口一致（收集 stdout/stderr、signal 可取消、进程注册管理）。
 */
export function runPooled(cmd, args, { signal, maxBuffer = 16 * 1024 * 1024, killGraceMs } = {}) {
  return acquire().then(() => {
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
      trackChild(child, { signal, killGraceMs })
    })
  })
}
