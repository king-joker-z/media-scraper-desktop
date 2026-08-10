/**
 * 任务报告通用收尾：collectFailures / finishReport 原先在 clean / rename / nfo / merge
 * 等执行器里各复制一份，这里统一为唯一实现。
 */

/**
 * 从 TaskCenter 运行结果中收集失败项到 report.failed。
 * @param {object} report 含 failed: Array 的报告对象
 * @param {object} result TaskCenter.run 的返回值
 * @param {Array} items 与 result.results 对齐的条目列表
 * @param {string} [key] 条目上作为 target 的字段名；不传则条目本身是字符串
 */
export function collectFailures(report, result, items, key) {
  result.results.forEach((entry, index) => {
    if (!entry || entry.ok || entry.cancelled) return
    const item = items[index]
    const target = key ? (item?.[key] ?? String(item)) : String(item)
    report.failed.push({ target, error: entry.error ?? '未知错误' })
  })
}

/** 收尾报告：写入取消标记与耗时并返回。 */
export function finishReport(report, startedAt, cancelled) {
  report.cancelled = cancelled
  report.durationMs = Date.now() - startedAt
  return report
}
