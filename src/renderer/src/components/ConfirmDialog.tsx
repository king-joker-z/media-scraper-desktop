import { useEffect, useRef, useState } from 'react'

import { formatBytes } from '../utils/format'

/**
 * 危险操作确认对话框：统一使用明确的勾选确认，避免用户重复输入确认词。
 */
function ConfirmDialog({
  title,
  deleteCount,
  deleteBytes,
  danger,
  extra,
  toggle,
  recoverable = false,
  ackLabel,
  cancelLabel = '取消',
  confirmLabel = '确认执行',
  secondaryAction,
  onConfirm,
  onCancel
}: {
  title: string
  deleteCount: number
  deleteBytes: number
  danger: boolean
  extra?: string
  /** 可选附加开关（如“同时删除关联 poster”） */
  toggle?: { label: string; checked: boolean; onChange: (checked: boolean) => void }
  /** 删除进回收站（可恢复）时为 true，文案相应调整 */
  recoverable?: boolean
  /** 非危险模式下的勾选确认语文案 */
  ackLabel?: string
  cancelLabel?: string
  confirmLabel?: string
  /** 可选的第三操作，如暂不保存直接离开当前页面 */
  secondaryAction?: { label: string; onAction: () => void }
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [checked, setChecked] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const canConfirm = checked

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href]'
        ) ?? [])
      ]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [onCancel])

  return (
    <div className="dialog-overlay" role="presentation">
      <div
        ref={dialogRef}
        className={`dialog ${danger ? 'danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <div className="dialog-body" aria-live="polite">
          {deleteCount > 0 && (
            <p>
              即将<b className="danger-text">删除 {deleteCount} 个文件</b>
              {deleteBytes > 0 && <>（共 {formatBytes(deleteBytes)}）</>}
              {recoverable ? '，将移入系统回收站（可从回收站恢复）。' : '，删除后不可恢复。'}
            </p>
          )}
          {extra && <p className="muted">{extra}</p>}
          {danger && <p className="danger-text">⚠️ 本次操作被判定为高风险，请确认后执行。</p>}
        </div>
        {toggle && (
          <label className="confirm-check">
            <input
              className="confirm-check-input"
              type="checkbox"
              checked={toggle.checked}
              onChange={(event) => toggle.onChange(event.target.checked)}
            />
            {toggle.label}
          </label>
        )}
        <label className="confirm-check">
          <input
            className="confirm-check-input"
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          {ackLabel ??
            (danger
              ? '我已了解风险，确认执行'
              : recoverable
                ? '我已了解，确认执行'
                : '我已了解删除不可恢复，确认执行')}
        </label>
        <div className="dialog-actions">
          <button ref={cancelRef} className="secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          {secondaryAction && (
            <button className="secondary" disabled={!canConfirm} onClick={secondaryAction.onAction}>
              {secondaryAction.label}
            </button>
          )}
          <button className="danger-button" disabled={!canConfirm} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
