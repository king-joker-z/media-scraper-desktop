/**
 * 监视器状态徽章：信号点 + 等宽文字（如 PREVIEW / MON A）。
 * 仅表达「监视器画面」语义，不伪造录制/编码状态；
 * 信号点呼吸动画在 prefers-reduced-motion 与降低效果下静止。
 */
function MonitorBadge({ text = 'PREVIEW' }: { text?: string }): React.JSX.Element {
  return (
    <span className="hud-monitor-badge" aria-hidden="true">
      <i className="hud-monitor-dot" />
      {text}
    </span>
  )
}

export default MonitorBadge
