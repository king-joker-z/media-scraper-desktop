import type { OpLogDetail, UndoPreflight } from '../../../shared/types'
import { operationLabel, renderOperationGlyph } from './operation-timeline-utils'

function OperationDetailPanel({
  detail,
  loading,
  preflight,
  preflightLoading,
  onReveal,
  onPreflight
}: {
  detail: OpLogDetail | null
  loading: boolean
  preflight: UndoPreflight | null
  preflightLoading: boolean
  onReveal: () => void
  onPreflight: () => void
}): React.JSX.Element {
  if (loading)
    return (
      <aside className="operation-detail-panel" aria-busy="true">
        正在读取操作详情…
      </aside>
    )
  if (!detail)
    return (
      <aside className="operation-detail-panel operation-detail-empty">
        选择一条记录，查看文件影响和撤销条件。
      </aside>
    )
  const canInspectUndo = detail.undoable && !detail.undone
  return (
    <aside className="operation-detail-panel">
      <header className="operation-detail-header">
        <span className="operation-detail-glyph">{renderOperationGlyph(detail.category)}</span>
        <div>
          <span className="section-kicker">
            {detail.legacy ? '旧格式记录 · 详情有限' : '已完成操作'}
          </span>
          <h3>{operationLabel(detail.module)}</h3>
          <p>{detail.summary}</p>
        </div>
      </header>

      <dl className="operation-detail-stats">
        <div>
          <dt>影响项</dt>
          <dd>{detail.affectedCount}</dd>
        </div>
        <div>
          <dt>成功</dt>
          <dd>{detail.successCount}</dd>
        </div>
        <div>
          <dt>失败</dt>
          <dd>{detail.failedCount}</dd>
        </div>
      </dl>

      <div className="operation-detail-actions">
        <button className="secondary" onClick={onReveal}>
          在文件管理器中定位日志
        </button>
        {canInspectUndo && (
          <button onClick={onPreflight} disabled={preflightLoading}>
            {preflightLoading ? '正在检查…' : '检查撤销条件'}
          </button>
        )}
      </div>
      {!canInspectUndo && (
        <p className="operation-no-undo">
          {detail.undone
            ? '这条操作已撤销，保留记录供追溯。'
            : detail.category === 'delete'
              ? '仅供追溯，不可自动恢复。删除类文件请从系统回收站恢复。'
              : '该操作不支持自动撤销。'}
        </p>
      )}

      {detail.undoReport && <UndoReportSummary report={detail.undoReport} />}
      {preflight && <UndoPreflightSummary preflight={preflight} />}

      <section className="operation-file-list" aria-label="受影响文件">
        <div className="operation-section-heading">
          <h4>受影响文件</h4>
          <span>{detail.items.length} 项</span>
        </div>
        {detail.items.length === 0 ? (
          <p className="muted">这条旧格式记录未保存文件级详情。</p>
        ) : (
          <ul>
            {detail.items.map((item, index) => (
              <li
                key={`${item.before ?? item.target ?? item.after}-${index}`}
                className={item.status}
              >
                {item.before && item.after ? (
                  <>
                    <code>{item.before}</code>
                    <span aria-hidden="true">→</span>
                    <code>{item.after}</code>
                  </>
                ) : (
                  <code>{item.target ?? item.after ?? item.before}</code>
                )}
                {item.error && <small role="alert">{item.error}</small>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}

export function UndoPreflightSummary({
  preflight
}: {
  preflight: UndoPreflight
}): React.JSX.Element {
  if (!preflight.canUndo)
    return (
      <p className="operation-preflight blocked" role="alert">
        无法撤销：{preflight.reason}
      </p>
    )
  return (
    <div className="operation-preflight" role="status">
      <b>撤销预检</b>
      <span>
        可恢复 {preflight.ready} 项 · 将跳过 {preflight.skipped} 项 · 可能重名{' '}
        {preflight.collisions} 项
      </span>
      {(preflight.skipped > 0 || preflight.collisions > 0) && (
        <small>最终执行时会再次检查，绝不会覆盖现有文件。</small>
      )}
    </div>
  )
}

function UndoReportSummary({
  report
}: {
  report: NonNullable<OpLogDetail['undoReport']>
}): React.JSX.Element {
  return (
    <div className="operation-preflight" role="status">
      <b>最近一次撤销结果</b>
      <span>
        回退 {report.undone} 项 · 跳过 {report.skipped} 项 · 失败 {report.failed.length} 项
      </span>
      {report.nfoRetained?.map((item) => (
        <small key={item.target}>{item.reason}</small>
      ))}
    </div>
  )
}

export default OperationDetailPanel
