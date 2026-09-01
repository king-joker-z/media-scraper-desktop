/**
 * 电影黑边（Letterbox）：视频监视器上下两条遮幅，纯 CSS，aria-hidden。
 * 非终端皮肤下 display:none。父元素需为定位上下文。
 */
function Letterbox(): React.JSX.Element {
  return (
    <span className="hud-letterbox" aria-hidden="true">
      <i className="hud-letterbox-top" />
      <i className="hud-letterbox-bottom" />
    </span>
  )
}

export default Letterbox
