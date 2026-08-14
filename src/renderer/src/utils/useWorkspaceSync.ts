import { useEffect, useRef } from 'react'

/**
 * 工作区同步 Hook：页面变为可见（或工作区切换）时对比内容指纹——
 * 无变化：保留页面已有状态，不重扫；
 * 有变化：自动触发该页的扫描函数。
 */
export function useWorkspaceSync(
  workspace: string,
  active: boolean,
  scan: () => Promise<void>
): void {
  const lastFingerprint = useRef<string | null>(null)
  const scanRef = useRef(scan)
  const busy = useRef(false)
  const runVersion = useRef(0)
  useEffect(() => {
    scanRef.current = scan
  }, [scan])

  useEffect(() => {
    if (!active || !workspace) return
    let alive = true
    const version = ++runVersion.current
    void (async () => {
      try {
        const fingerprint = await window.api.getWorkspaceFingerprint(workspace)
        if (!alive || version !== runVersion.current || busy.current) return
        if (fingerprint !== lastFingerprint.current) {
          busy.current = true
          lastFingerprint.current = fingerprint
          try {
            // 指纹请求返回后工作区仍可能已切换，扫描前再次阻止过期结果写回页面状态。
            if (alive && version === runVersion.current) await scanRef.current()
          } finally {
            // 已切换工作区时，不能由旧任务重置新一轮扫描的 busy 标记。
            if (version === runVersion.current) busy.current = false
          }
        }
      } catch {
        // 指纹计算失败（目录被删等）时静默跳过，页面保持原状
      }
    })()
    return () => {
      alive = false
      runVersion.current += 1
      // 旧扫描可继续在后台收尾，但新工作区不能被其 busy 标记阻塞。
      busy.current = false
    }
  }, [active, workspace])
}
