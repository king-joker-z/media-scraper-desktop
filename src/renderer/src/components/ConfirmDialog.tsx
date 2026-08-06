import { useState } from 'react'

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
  onConfirm,
  onCancel
}: {
  title: string
  deleteCount: number
  deleteBytes: number
  danger: boolean
  extra?: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [checked, setChecked] = useState(false)
  const [word, setWord] = useState('')
  const canConfirm = danger ? word === CONFIRM_WORD : checked

  return (
    <div className="dialog-overlay">
      <div className={`dialog ${danger ? 'danger' : ''}`}>
        <h2>{title}</h2>
        <div className="dialog-body">
          <p>
            即将<b className="danger-text">永久删除 {deleteCount} 个文件</b>（共{' '}
            {formatBytes(deleteBytes)}），删除后不可恢复。
          </p>
          {extra && <p className="muted">{extra}</p>}
          {danger && (
            <p className="danger-text">
              ⚠️ 本次操作被判定为高风险（删除数量大 / 体积大 / 工作区内无视频），请输入「
              {CONFIRM_WORD}」以确认：
            </p>
          )}
        </div>
        {danger ? (
          <input
            autoFocus
            className="confirm-input"
            placeholder={`请输入：${CONFIRM_WORD}`}
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
            我已了解删除不可恢复，确认执行
          </label>
        )}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
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
