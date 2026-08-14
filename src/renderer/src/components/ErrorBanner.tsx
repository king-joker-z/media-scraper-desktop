import { useEffect, useRef, useState } from 'react'

/** 错误横幅：展示错误详情，支持一键复制（ffmpeg/AI 报错需要可粘贴排查）与手动关闭 */
function ErrorBanner({ message }: { message: string }): React.JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 记录被关闭的那条错误内容：同一条保持关闭，新错误（内容变化）自动重新展示
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
      // 剪贴板不可用（权限拒绝等）时静默
    }
  }

  return (
    <section className="error-banner" role="alert" aria-live="assertive">
      <span className="error-text">{message}</span>
      <button className="error-copy" onClick={copy}>
        {copied ? '已复制 ✓' : '复制详情'}
      </button>
      <button
        className="error-copy"
        title="关闭"
        aria-label="关闭错误提示"
        onClick={() => setDismissedFor(message)}
      >
        ✕
      </button>
    </section>
  )
}

export default ErrorBanner
