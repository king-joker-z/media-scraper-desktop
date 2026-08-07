export const MIN_CONCURRENCY = 1
export const MAX_CONCURRENCY = 20
export const DEFAULT_CONCURRENCY = 5

export const clampConcurrency = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(n)))
}

const describeItem = (item) => {
  if (typeof item === 'string') return item
  if (item && typeof item === 'object') {
    return item.relativePath ?? item.path ?? item.name ?? JSON.stringify(item)
  }
  return String(item)
}

/**
 * 任务中心：统一并发调度（冻结稿 §2.4，默认 5、1–20 可配；视频合并单独限流）。
 * 纯 Node 实现、不依赖 Electron，通过 emit 回调向外推送 TaskEvent。
 */
export function createTaskCenter({ emit } = {}) {
  const controllers = new Map()

  /**
   * @param {object} options
   * @param {string} options.taskId 任务唯一 id
   * @param {string} options.label 任务可读名称
   * @param {Array} options.items 待处理项
   * @param {(item: any, signal: AbortSignal) => Promise<any>} options.worker 单项处理器
   * @param {number} [options.concurrency] 并发数（自动 clamp 到 1-20）
   * @returns {Promise<{cancelled: boolean, completed: number, failed: number, results: Array}>}
   */
  async function run({ taskId, label, items, worker, concurrency = DEFAULT_CONCURRENCY }) {
    const total = items.length
    const lanes = clampConcurrency(concurrency)
    const controller = new AbortController()
    controllers.set(taskId, controller)

    let cursor = 0
    let completed = 0
    let failed = 0
    const results = new Array(total)
    const snapshot = () => ({ taskId, label, total, completed, failed, at: Date.now() })

    emit?.({ type: 'start', ...snapshot() })

    const lane = async () => {
      while (cursor < items.length && !controller.signal.aborted) {
        const index = cursor
        cursor += 1
        const item = items[index]
        const current = describeItem(item)
        emit?.({ type: 'progress', current, ...snapshot() })
        try {
          results[index] = { ok: true, value: await worker(item, controller.signal) }
          completed += 1
          emit?.({ type: 'item-done', current, ...snapshot() })
        } catch (error) {
          if (controller.signal.aborted) {
            results[index] = { ok: false, cancelled: true }
            return
          }
          failed += 1
          const message = error instanceof Error ? error.message : String(error)
          results[index] = { ok: false, error: message }
          emit?.({ type: 'item-error', current, error: message, ...snapshot() })
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(lanes, total) }, lane))
    controllers.delete(taskId)

    const cancelled = controller.signal.aborted
    emit?.({ type: cancelled ? 'cancelled' : 'done', ...snapshot() })
    return { cancelled, completed, failed, results }
  }

  function cancel(taskId) {
    controllers.get(taskId)?.abort()
  }

  /** 取消全部在途任务（应用退出前收尾用） */
  function cancelAll() {
    for (const controller of controllers.values()) controller.abort()
  }

  /** 是否有在途任务 */
  function hasActive() {
    return controllers.size > 0
  }

  return { run, cancel, cancelAll, hasActive }
}
