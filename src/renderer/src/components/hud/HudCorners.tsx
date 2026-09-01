/**
 * HUD 四角括号：纯装饰元素（aria-hidden），样式完全由皮肤 CSS 控制。
 * 非终端类皮肤下整体 display:none，不产生任何视觉与布局负担。
 * 父元素需为定位上下文（position: relative/absolute 等）。
 */
function HudCorners({
  className = '',
  size = 'm'
}: {
  className?: string
  /** 括号尺寸档位：s=卡片内小括号，m=面板，l=整屏框架 */
  size?: 's' | 'm' | 'l'
}): React.JSX.Element {
  return (
    <span className={`hud-corners hud-corners-${size} ${className}`} aria-hidden="true">
      <i className="hud-corner hud-corner-tl" />
      <i className="hud-corner hud-corner-tr" />
      <i className="hud-corner hud-corner-bl" />
      <i className="hud-corner hud-corner-br" />
    </span>
  )
}

export default HudCorners
