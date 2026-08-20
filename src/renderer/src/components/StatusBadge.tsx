type StatusTone = 'neutral' | 'running' | 'success' | 'warning' | 'danger'

const TONE_LABEL: Record<StatusTone, string> = {
  neutral: '信息',
  running: '进行中',
  success: '已完成',
  warning: '需注意',
  danger: '异常'
}

/** 状态同时以文字、图形和颜色表达，避免仅靠颜色传递任务结果。 */
function StatusBadge({
  tone = 'neutral',
  children,
  className = ''
}: {
  tone?: StatusTone
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span className={`status-badge status-${tone} ${className}`.trim()}>
      <span className="status-badge-mark" aria-hidden="true" />
      <span className="status-badge-label">{TONE_LABEL[tone]}：</span>
      {children}
    </span>
  )
}

export default StatusBadge
