import { useCallback, useEffect, useRef } from 'react'

/**
 * 为异步工作区请求生成版本号。工作区改变时旧版本立即失效，
 * 避免旧目录的响应覆盖新目录页面状态。
 */
export function useWorkspaceRequestVersion(workspace: string): {
  begin: () => number
  isCurrent: (version: number, requestWorkspace: string) => boolean
} {
  const versionRef = useRef(0)
  const workspaceRef = useRef(workspace)

  useEffect(() => {
    workspaceRef.current = workspace
    versionRef.current += 1
  }, [workspace])

  const begin = useCallback(() => {
    versionRef.current += 1
    return versionRef.current
  }, [])
  const isCurrent = useCallback(
    (version: number, requestWorkspace: string) =>
      version === versionRef.current && requestWorkspace === workspaceRef.current,
    []
  )
  return { begin, isCurrent }
}
