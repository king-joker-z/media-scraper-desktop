import { useState } from 'react'

/** 错误横幅：展示错误详情并支持一键复制（ffmpeg/AI 报错需要可粘贴排查） */
function ErrorBanner({ message }: { message: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用（权限拒绝等）时静默
    }
  }

  return (
    <section className="error-banner">
      <span className="error-text">{message}</span>
      <button className="error-copy" onClick={copy}>
        {copied ? '已复制 ✓' : '复制详情'}
      </button>
    </section>
  )
}

export default ErrorBanner
