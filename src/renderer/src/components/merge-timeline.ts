import type { MergeCompatibility, MergeVideoItem } from '../../../shared/types'

export interface TimelineSegment {
  item: MergeVideoItem
  index: number
  startMs: number
  endMs: number
  /** 是否参与本次输出；排除项仅显示在时间线下方的旁路栏。 */
  included: boolean
  /** 参与项按时长计算，排除项为 0 并由旁路栏使用固定宽度。 */
  widthWeight: number
}

/** 根据当前参与顺序生成时间线坐标；排除项不计入输出时长。 */
export function buildTimelineSegments(
  items: MergeVideoItem[],
  excluded: Set<string>
): TimelineSegment[] {
  let cursorMs = 0
  return items.map((item, index) => {
    const durationMs = Math.max(0, item.media?.durationMs ?? 0)
    const included = !excluded.has(item.relativePath)
    const startMs = cursorMs
    if (included) cursorMs += durationMs
    return {
      item,
      index,
      startMs,
      endMs: cursorMs,
      included,
      // 最低权重使短片段仍可操作，视觉比例仍由真实时长主导；
      // 排除项不属于输出轨道，交由旁路栏使用固定窄宽度展示。
      widthWeight: included ? Math.max(durationMs / 1000, 8) : 0
    }
  })
}

export function timelineDurationMs(items: MergeVideoItem[], excluded: Set<string>): number {
  return items.reduce(
    (total, item) => total + (excluded.has(item.relativePath) ? 0 : (item.media?.durationMs ?? 0)),
    0
  )
}

export function outputSpecLabel(compatibility: MergeCompatibility): string {
  if (compatibility.compatible) return '兼容直拼，无重编码'
  if (!compatibility.target) return '无法确定输出规格'
  const { width, height, fps, pixFmt } = compatibility.target
  return `${width}×${height} · ${fps.toFixed(0)} fps · ${pixFmt}`
}

export function orientationLabel(item: MergeVideoItem): string {
  return item.media?.orientation === 'portrait' ? '竖屏' : '横屏'
}
