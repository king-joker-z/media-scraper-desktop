import { useEffect, useRef, useState } from 'react'

import { formatBytes } from '../utils/format'

const CONFIRM_WORD = '永久删除'

/**
 * 永久删除确认对话框（冻结稿 §2.6）：
 * - 常规：勾选"我已了解"后放行
 * - 危险（删除数>50 / 体积>1GB / 无视频）：必须输入确认词
 */
function ConfirmDialog({
  title,
  deleteCount,
  deleteBytes,
  danger,
  extra,
  confirmWord = CONFIRM_WORD,
  toggle,
  recoverable = false,
  ackLabel,
  onConfirm,
  onCancel
}: {
  title: string
  deleteCount: number
  deleteBytes: number
  danger: boolean
  extra?: string
  /** 危险模式下要求输入的确认词，默认「永久删除」 */
  confirmWord?: string
  /** 可选附加开关（如“同时删除关联 poster”） */
  toggle?: { label: string; checked: boolean; onChange: (checked: boolean) => void }
  /** 删除进回收站（可恢复）时为 true，文案相应调整 */
  recoverable?: boolean
  /** 非危险模式下的勾选确认语文案 */
  ackLabel?: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [checked, setChecked] = useState(false)
  const [word, setWord] = useState('')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const canConfirm = danger ? word === confirmWord : checked

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ;(danger ? inputRef.current : cancelRef.current)?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [danger, onCancel])

  return (
    <div className="dialog-overlay" role="presentation">
      <div
        className={`dialog ${danger ? 'danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <div className="dialog-body">
          {deleteCount > 0 && (
            <p>
              即将<b className="danger-text">删除 {deleteCount} 个文件</b>
              {deleteBytes > 0 && <>（共 {formatBytes(deleteBytes)}）</>}
              {recoverable ? '，将移入系统回收站（可从回收站恢复）。' : '，删除后不可恢复。'}
            </p>
          )}
          {extra && <p className="muted">{extra}</p>}
          {danger && (
            <p className="danger-text">
              ⚠️ 本次操作被判定为高风险，请输入「{confirmWord}」以确认：
            </p>
          )}
        </div>
        {toggle && (
          <label className="confirm-check">
            <input
              type="checkbox"
              checked={toggle.checked}
              onChange={(event) => toggle.onChange(event.target.checked)}
            />
            {toggle.label}
          </label>
        )}
        {danger ? (
          <input
            ref={inputRef}
            className="confirm-input"
            placeholder={`请输入：${confirmWord}`}
            value={word}
            onChange={(event) => setWord(event.target.value)}
          />
        ) : (
          <label className="confirm-check">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            {ackLabel ?? (recoverable ? '我已了解，确认执行' : '我已了解删除不可恢复，确认执行')}
          </label>
        )}
        <div className="dialog-actions">
          <button ref={cancelRef} className="secondary" onClick={onCancel}>
            取消
          </button>
          <button className="danger-button" disabled={!canConfirm} onClick={onConfirm}>
            确认执行
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
