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
  useEffect(() => {
    scanRef.current = scan
  }, [scan])

  useEffect(() => {
    if (!active || !workspace) return
    let alive = true
    void (async () => {
      try {
        const fingerprint = await window.api.getWorkspaceFingerprint(workspace)
        if (!alive || busy.current) return
        if (fingerprint !== lastFingerprint.current) {
          busy.current = true
          lastFingerprint.current = fingerprint
          try {
            await scanRef.current()
          } finally {
            busy.current = false
          }
        }
      } catch {
        // 指纹计算失败（目录被删等）时静默跳过，页面保持原状
      }
    })()
    return () => {
      alive = false
    }
  }, [active, workspace])
}
