import { useEffect, useRef, useState } from 'react'

import { usePalette } from '../hooks/usePalette'

/** 错误横幅：展示可执行的错误说明，支持复制详情与手动关闭。不同皮肤渲染不同结构。 */
function ErrorBanner({ message }: { message: string }): React.JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const palette = usePalette()

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

  const actions = (
    <>
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
    </>
  )

  /* terminal：mono // FAULT 前缀 + 描红读数条
     comic：黑框黄底警示牌
     comic-ukiyo：和纸警示 + 朱印「警」 */
  const variantCls =
    palette === 'terminal'
      ? 'terminal-error'
      : palette === 'comic'
        ? 'comic-error'
        : palette === 'comic-ukiyo'
          ? 'ukiyo-error'
          : ''

  if (variantCls) {
    return (
      <section className={`error-banner ${variantCls}`} role="alert" aria-live="assertive">
        {palette === 'terminal' && (
          <i className="eb-tag" aria-hidden="true">
            {'// FAULT'}
          </i>
        )}
        {palette === 'comic-ukiyo' && (
          <span className="eb-seal" aria-hidden="true">
            警
          </span>
        )}
        <div className={`error-text ${variantCls === 'ukiyo-error' ? 'eb-serif' : ''}`}>
          <b>{palette === 'comic' ? '操作未完成！' : '操作未完成'}</b>
          <span>{message}</span>
        </div>
        {actions}
      </section>
    )
  }

  return (
    <section className="error-banner" role="alert" aria-live="assertive">
      <div className="error-text">
        <b>操作未完成</b>
        <span>{message}</span>
      </div>
      {actions}
    </section>
  )
}

export default ErrorBanner
