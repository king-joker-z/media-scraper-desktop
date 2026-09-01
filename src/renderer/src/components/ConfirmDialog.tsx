import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'

import { formatBytes } from '../utils/format'
import { usePalette } from '../hooks/usePalette'

/** 危险操作确认对话框：Radix 负责跨平台焦点与无障碍隔离，业务确认仍需明确勾选。 */
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
  toggle?: { label: string; checked: boolean; onChange: (checked: boolean) => void }
  recoverable?: boolean
  ackLabel?: string
  cancelLabel?: string
  confirmLabel?: string
  secondaryAction?: { label: string; onAction: () => void }
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [checked, setChecked] = useState(false)
  const canConfirm = checked
  const palette = usePalette()

  const variantCls =
    palette === 'terminal'
      ? 'terminal-dialog'
      : palette === 'comic'
        ? 'comic-dialog'
        : palette === 'comic-ukiyo'
          ? 'ukiyo-dialog'
          : ''

  /* 删除数量行：每皮不同 DOM（读数条 / 音效高亮 / 朱印衬线句） */
  const deleteLine =
    deleteCount > 0 ? (
      palette === 'terminal' ? (
        <div className="cd-read" aria-live="polite">
          <i aria-hidden="true">DELETE</i>
          <b>{deleteCount}</b>
          <span>
            {`FILES · ${deleteBytes > 0 ? formatBytes(deleteBytes) : '—'} ·`}{' '}
            {recoverable ? 'TO TRASH' : 'PERMANENT'}
          </span>
        </div>
      ) : palette === 'comic' ? (
        <p className="cd-comic-line" aria-live="polite">
          即将删除
          <mark>{deleteCount} 个文件</mark>
          {deleteBytes > 0 && <>（共 {formatBytes(deleteBytes)}）</>}
          {recoverable ? '，将移入系统回收站（可从回收站恢复）。' : '，删除后不可恢复。'}
        </p>
      ) : palette === 'comic-ukiyo' ? (
        <p className="cd-ukiyo-line" aria-live="polite">
          <span className="cd-ukiyo-seal" aria-hidden="true">
            删
          </span>
          即将删除<b className="danger-text">{deleteCount} 个文件</b>
          {deleteBytes > 0 && <>（共 {formatBytes(deleteBytes)}）</>}
          {recoverable ? '，将移入系统回收站（可从回收站恢复）。' : '，删除后不可恢复。'}
        </p>
      ) : (
        <p>
          即将<b className="danger-text">删除 {deleteCount} 个文件</b>
          {deleteBytes > 0 && <>（共 {formatBytes(deleteBytes)}）</>}
          {recoverable ? '，将移入系统回收站（可从回收站恢复）。' : '，删除后不可恢复。'}
        </p>
      )
    ) : null

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={`dialog ${danger ? 'danger' : ''} ${variantCls}`}>
          <Dialog.Title>{title}</Dialog.Title>
          {variantCls === 'ukiyo-dialog' && <u className="cd-wave" aria-hidden="true" />}
          <Dialog.Description className="dialog-body" asChild>
            <div aria-live="polite">
              {deleteLine}
              {extra && <p className="muted">{extra}</p>}
              {danger && <p className="danger-text">本次操作被判定为高风险，请确认后执行。</p>}
            </div>
          </Dialog.Description>
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
            <Dialog.Close className="secondary" onClick={onCancel}>
              {cancelLabel}
            </Dialog.Close>
            {secondaryAction && (
              <button
                className="secondary"
                disabled={!canConfirm}
                onClick={secondaryAction.onAction}
              >
                {secondaryAction.label}
              </button>
            )}
            <button className="danger-button" disabled={!canConfirm} onClick={onConfirm}>
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export default ConfirmDialog
