import type { OpLogSummary } from '../../../shared/types'
import { operationLabel, renderOperationGlyph } from './operation-timeline-utils'

const formatOperationTime = (value: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)
}

function OperationTimelineItem({
  log,
  selected,
  onSelect
}: {
  log: OpLogSummary
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const status = log.undone
    ? '已撤销'
    : log.undoable
      ? '可撤销'
      : log.category === 'delete'
        ? '仅供追溯'
        : '已记录'
  return (
    <button
      className={`operation-timeline-item ${selected ? 'selected' : ''} ${log.undone ? 'undone' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="operation-timeline-rail" aria-hidden="true" />
      <span className="operation-timeline-icon">{renderOperationGlyph(log.category)}</span>
      <span className="operation-timeline-copy">
        <span className="operation-timeline-title">{operationLabel(log.module)}</span>
        <span className="operation-timeline-summary">{log.summary}</span>
        <span className="operation-timeline-metrics">
          影响 {log.affectedCount} 项 · 成功 {log.successCount}
          {log.failedCount > 0 ? ` · 失败 ${log.failedCount}` : ''}
        </span>
      </span>
      <span className="operation-timeline-side">
        <time dateTime={log.finishedAt}>{formatOperationTime(log.finishedAt)}</time>
        <b
          className={`operation-status ${log.undone ? 'undone' : log.undoable ? 'available' : ''}`}
        >
          {status}
        </b>
      </span>
    </button>
  )
}

export default OperationTimelineItem
