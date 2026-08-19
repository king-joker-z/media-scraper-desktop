import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProbeContainerItem } from '../../../shared/types'
import {
  analyzeRenameRelationships,
  matchesRenameFilter,
  type RenameComparisonRow,
  type RenameFilter,
  type RenameRelationship
} from './rename-comparison'

const FILTERS: { key: RenameFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'changed', label: '将变更' },
  { key: 'unchanged', label: '无变更' },
  { key: 'conflict', label: '冲突' },
  { key: 'windows', label: 'Windows 不兼容' },
  { key: 'manual', label: '手动覆写' },
  { key: 'ai', label: 'AI 结果' }
]

function statusText(row: RenameComparisonRow, probe?: ProbeContainerItem): string {
  if (row.error) return row.error
  if (row.risk === 'probe') return `探测失败：${row.probeError ?? '未知错误'}`
  if (row.risk === 'external')
    return `外部占用：将自动追加 (n)（${row.externalCollisions.join('、')}）`
  if (row.risk === 'extension') return '真实容器不是 MP4，仅改后缀可能无法播放'
  if (row.targetExtension !== row.originalExtension && probe?.isMp4)
    return `容器 ${probe.container}`
  if (!row.changed) return '名称不变'
  if (row.manual) return '手动覆写'
  if (row.ai) return 'AI 命名结果'
  return '可执行'
}

function relationshipText(
  relationship: RenameRelationship,
  rowByVideo: Map<string, RenameComparisonRow>
): string {
  const names = relationship.members
    .map((rel) => rowByVideo.get(rel)?.source.name)
    .filter(Boolean)
    .join(' → ')
  return names ? `${relationship.label}：${names}` : relationship.label
}

export default function RenameComparisonEditor({
  rows,
  probes,
  mode,
  selectedAiVideos,
  onSelectedAiVideosChange,
  onChange,
  onReset,
  onRegenerate,
  regenerating,
  busy
}: {
  rows: RenameComparisonRow[]
  probes: Record<string, ProbeContainerItem>
  mode: 'seq' | 'regex' | 'ai' | 'ext'
  selectedAiVideos: Set<string>
  onSelectedAiVideosChange: (next: Set<string>) => void
  onChange: (videoRel: string, value: string) => void
  onReset: (videoRel: string) => void
  onRegenerate: (videoRel: string) => void
  regenerating: string | null
  busy: boolean
}): React.JSX.Element {
  const [filter, setFilter] = useState<RenameFilter>('all')
  const [query, setQuery] = useState('')
  const [editingRel, setEditingRel] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [page, setPage] = useState(0)
  const pageSize = 200
  const searchRef = useRef<HTMLInputElement>(null)
  const editorInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingRel) editorInputRef.current?.focus()
  }, [editingRel])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchRef.current?.focus()
      }
      if (event.key === 'Escape' && editingRel) {
        event.preventDefault()
        event.stopPropagation()
        setEditingRel(null)
        setDraft('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editingRel])

  const visibleRows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return rows.filter(
      (row) =>
        matchesRenameFilter(row, filter) &&
        (!normalized ||
          row.source.name.toLocaleLowerCase().includes(normalized) ||
          row.targetName.toLocaleLowerCase().includes(normalized) ||
          row.videoRel.toLocaleLowerCase().includes(normalized))
    )
  }, [filter, query, rows])
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pagedRows = visibleRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  const rowByVideo = useMemo(() => new Map(rows.map((row) => [row.videoRel, row])), [rows])
  const relationships = useMemo(() => analyzeRenameRelationships(rows), [rows])
  const visibleAiRows = useMemo(() => visibleRows.filter((row) => row.ai), [visibleRows])
  const visibleAiSelectedCount = visibleAiRows.filter((row) =>
    selectedAiVideos.has(row.videoRel)
  ).length
  const allVisibleAiSelected =
    visibleAiRows.length > 0 && visibleAiRows.every((row) => selectedAiVideos.has(row.videoRel))
  const summary = useMemo(
    () => ({
      changedCount: rows.filter((row) => row.changed).length,
      conflictCount: rows.filter((row) => row.risk === 'conflict').length,
      extensionRiskCount: rows.filter((row) => row.risk === 'extension').length,
      selectedAiCount: rows.filter((row) => selectedAiVideos.has(row.videoRel)).length,
      allAiSelected: rows.length > 0 && rows.every((row) => selectedAiVideos.has(row.videoRel)),
      posterCount: rows.filter((row) => row.source.posterRelativePath && row.changed).length
    }),
    [rows, selectedAiVideos]
  )

  const beginEdit = (row: RenameComparisonRow): void => {
    if (row.targetExtension !== row.originalExtension || busy) return
    setEditingRel(row.videoRel)
    setDraft(row.targetStem)
  }
  const commitEdit = (row: RenameComparisonRow): void => {
    if (draft !== row.computedStem) onChange(row.videoRel, draft)
    else if (row.manual) onReset(row.videoRel)
    setEditingRel(null)
  }
  const moveSelection = (direction: number): void => {
    const current = pagedRows.findIndex(
      (row) => row.videoRel === document.activeElement?.getAttribute('data-video-rel')
    )
    const next = pagedRows[Math.max(0, Math.min(pagedRows.length - 1, current + direction))]
    if (next)
      document
        .querySelector<HTMLElement>(`[data-video-rel="${CSS.escape(next.videoRel)}"]`)
        ?.focus()
  }

  return (
    <section className="rename-comparison" aria-label="重命名前后对照编辑器">
      <div className="rename-comparison-toolbar">
        <div className="rename-filter-list" role="toolbar" aria-label="筛选重命名预览">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              className={`rename-filter ${filter === item.key ? 'active' : ''}`}
              type="button"
              aria-pressed={filter === item.key}
              onClick={() => {
                setFilter(item.key)
                setPage(0)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="rename-search">
          <input
            ref={searchRef}
            aria-label="筛选文件"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(0)
            }}
            placeholder="筛选名称或路径"
          />
          <kbd>⌘/Ctrl F</kbd>
        </label>
      </div>

      {relationships.length > 0 && (
        <div className="rename-relationship-notice" role="status">
          <strong>安全改名关系</strong>
          {relationships.map((relationship) => (
            <span key={`${relationship.kind}-${relationship.members.join('|')}`}>
              {relationshipText(relationship, rowByVideo)}
            </span>
          ))}
        </div>
      )}

      <div className="rename-editor-grid" role="grid" aria-label="文件名对照表">
        <div className="rename-editor-head" role="row">
          {mode === 'ai' && <span role="columnheader" className="rename-editor-select" />}
          <span role="columnheader">原文件</span>
          <span role="columnheader">规则轨迹</span>
          <span role="columnheader">目标文件</span>
          <span role="columnheader">状态</span>
          <span role="columnheader">操作</span>
        </div>
        <div className="rename-editor-scroll">
          {pagedRows.map((row) => {
            const isEditing = editingRel === row.videoRel
            return (
              <div
                key={row.videoRel}
                className={`rename-editor-row ${row.error ? 'invalid' : ''}`}
                role="row"
                tabIndex={0}
                data-video-rel={row.videoRel}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    moveSelection(1)
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    moveSelection(-1)
                  }
                  if (event.key === 'Enter' && !isEditing) beginEdit(row)
                }}
              >
                {mode === 'ai' && (
                  <span
                    className="rename-editor-select"
                    role="gridcell"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      aria-label={`选择 ${row.source.name}`}
                      checked={selectedAiVideos.has(row.videoRel)}
                      onChange={(event) => {
                        const next = new Set(selectedAiVideos)
                        if (event.target.checked) next.add(row.videoRel)
                        else next.delete(row.videoRel)
                        onSelectedAiVideosChange(next)
                      }}
                    />
                  </span>
                )}
                <span className="rename-editor-original" role="gridcell" title={row.videoRel}>
                  <b>{row.source.name}</b>
                  <small>{row.videoRel}</small>
                  {row.source.posterRelativePath && <em>关联 poster 会同步改名</em>}
                </span>
                <span className="rename-editor-steps" role="gridcell">
                  {row.ruleSteps.slice(0, 2).map((step, index) => (
                    <span key={`${step.label}-${index}`} title={`${step.before} → ${step.after}`}>
                      <b>{step.label}</b>
                      <code>
                        {step.before} → {step.after}
                      </code>
                    </span>
                  ))}
                </span>
                <span
                  className="rename-editor-target"
                  role="gridcell"
                  onDoubleClick={() => beginEdit(row)}
                >
                  {isEditing ? (
                    <input
                      ref={editorInputRef}
                      value={draft}
                      aria-label={`编辑 ${row.source.name} 的目标词干`}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => commitEdit(row)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          commitEdit(row)
                        }
                        if (event.key === 'Escape') {
                          setEditingRel(null)
                          setDraft('')
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={row.targetExtension !== row.originalExtension || busy}
                      onClick={() => beginEdit(row)}
                      title="点击编辑目标名称"
                    >
                      {row.targetName}
                    </button>
                  )}
                  {row.manual && <em>已手动覆写</em>}
                </span>
                <span className={`rename-editor-status ${row.risk}`} role="gridcell">
                  <b>{statusText(row, probes[row.videoRel])}</b>
                </span>
                <span
                  className="rename-editor-actions"
                  role="gridcell"
                  onClick={(event) => event.stopPropagation()}
                >
                  {row.manual && (
                    <button type="button" onClick={() => onReset(row.videoRel)} disabled={busy}>
                      恢复计算值
                    </button>
                  )}
                  {row.ai && (
                    <button
                      type="button"
                      onClick={() => onRegenerate(row.videoRel)}
                      disabled={busy || regenerating === row.videoRel}
                    >
                      {regenerating === row.videoRel ? '生成中…' : '重新生成'}
                    </button>
                  )}
                </span>
              </div>
            )
          })}
          {visibleRows.length === 0 && <p className="rename-editor-empty">没有匹配的预览项。</p>}
        </div>
      </div>

      {visibleRows.length > pageSize && (
        <nav className="rename-pagination" aria-label="重命名预览分页">
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => setPage((value) => value - 1)}
          >
            上一页
          </button>
          <span>
            第 {currentPage + 1} / {pageCount} 页，每页 {pageSize} 项
          </span>
          <button
            type="button"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页
          </button>
        </nav>
      )}

      <footer className="rename-editor-summary">
        <span>
          共 <b>{rows.length}</b> 项
        </span>
        <span>
          将改名 <b>{summary.changedCount}</b> 项
        </span>
        <span className={summary.conflictCount ? 'danger' : ''}>
          冲突 <b>{summary.conflictCount}</b> 项
        </span>
        <span className={summary.extensionRiskCount ? 'warning' : ''}>
          扩展名风险 <b>{summary.extensionRiskCount}</b> 项
        </span>
        <span>
          关联封面 <b>{summary.posterCount}</b> 项
        </span>
        {mode === 'ai' && (
          <label className="rename-editor-select-all">
            <input
              type="checkbox"
              checked={allVisibleAiSelected}
              onChange={(event) => {
                const next = new Set(selectedAiVideos)
                for (const row of visibleAiRows) {
                  if (event.target.checked) next.add(row.videoRel)
                  else next.delete(row.videoRel)
                }
                onSelectedAiVideosChange(next)
              }}
            />
            选择当前筛选结果（{visibleAiSelectedCount}/{visibleAiRows.length}）
          </label>
        )}
      </footer>
    </section>
  )
}
