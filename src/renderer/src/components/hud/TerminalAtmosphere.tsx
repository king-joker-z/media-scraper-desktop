/**
 * 终端氛围层：蓝图网格 + 扫描线 + 慢速扫描光束 + 细颗粒噪点。
 * 全部纯 CSS 绘制（线性渐变 + SVG feTurbulence data-URI），无 Canvas / WebGL，
 * 动画仅 transform / opacity，保持单一合成层。
 * 停摆策略由 CSS 统一负责：批量任务（data-task-busy）、降低视觉效果
 * （data-performance-mode='reduced'）与 prefers-reduced-motion 下全部静止。
 * 组件本身无状态、不订阅任何事件。
 */
function TerminalAtmosphere(): React.JSX.Element {
  return (
    <span className="terminal-atmosphere" aria-hidden="true">
      <i className="terminal-grid" />
      <i className="terminal-scanlines" />
      <i className="terminal-scanbeam" />
      <i className="terminal-noise" />
    </span>
  )
}

export default TerminalAtmosphere
