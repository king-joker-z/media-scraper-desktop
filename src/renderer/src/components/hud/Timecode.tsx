import { formatTimecode } from '../../utils/format'

/**
 * 片场时码芯片：等宽 HH:MM:SS.mmm 显示。
 * 纯格式化组件，不持有状态；实时刷新的播放时码由调用方用 ref 直写文本，
 * 避免逐帧触发 React 渲染。
 */
function Timecode({
  ms,
  label
}: {
  ms: number
  /** 可选前缀标签（如 IN / OUT / DUR），等宽小号显示 */
  label?: string
}): React.JSX.Element {
  return (
    <span className="hud-timecode">
      {label && <i aria-hidden="true">{label}</i>}
      {formatTimecode(ms)}
    </span>
  )
}

export default Timecode
