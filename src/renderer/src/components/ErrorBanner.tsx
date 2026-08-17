import { useEffect, useRef, useState } from 'react'

/** 错误横幅：展示可执行的错误说明，支持复制详情与手动关闭。 */
function ErrorBanner({ message }: { message: string }): React.JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    []
  )

  if (dismissedFor === message) return null

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => {
        copiedTimer.current = null
        setCopied(false)
      }, 1500)
    } catch {
      // 剪贴板不可用（权限拒绝等）时保留错误内容供用户手动复制。
    }
  }

  return (
    <section className="error-banner" role="alert" aria-live="assertive">
      <div className="error-text">
        <b>操作未完成</b>
        <span>{message}</span>
      </div>
      <button className="error-copy" onClick={() => void copy()}>
        {copied ? '已复制' : '复制详情'}
      </button>
      <button
        className="error-copy"
        title="关闭错误提示"
        aria-label="关闭错误提示"
        onClick={() => setDismissedFor(message)}
      >
        关闭
      </button>
    </section>
  )
}

export default ErrorBanner
