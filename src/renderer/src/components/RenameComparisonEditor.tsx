import {
  columnResizingFeature,
  columnSizingFeature,
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures as createTableFeatures,
  useTable,
  type SortingState
} from '@tanstack/react-table'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

const renameTableFeatures = createTableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  columnSizingFeature,
  columnResizingFeature
})

const columnHelper = createColumnHelper<typeof renameTableFeatures, RenameComparisonRow>()

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
  const [sorting, setSorting] = useState<SortingState>([{ id: 'riskRank', desc: false }])
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
      posterCount: rows.filter((row) => row.source.posterRelativePath && row.changed).length
    }),
    [rows]
  )

  const beginEdit = useCallback(
    (row: RenameComparisonRow): void => {
      if (row.targetExtension !== row.originalExtension || busy) return
      setEditingRel(row.videoRel)
      setDraft(row.targetStem)
    },
    [busy]
  )
  const commitEdit = useCallback(
    (row: RenameComparisonRow): void => {
      if (draft !== row.computedStem) onChange(row.videoRel, draft)
      else if (row.manual) onReset(row.videoRel)
      setEditingRel(null)
    },
    [draft, onChange, onReset]
  )

  const columns = useMemo(
    () => [
      ...(mode === 'ai'
        ? [
            columnHelper.display({
              id: 'select',
              header: '选择',
              size: 66,
              minSize: 66,
              maxSize: 66,
              cell: ({ row }) => {
                const value = row.original
                return (
                  <input
                    type="checkbox"
                    aria-label={`选择 ${value.source.name}`}
                    checked={selectedAiVideos.has(value.videoRel)}
                    onChange={(event) => {
                      const next = new Set(selectedAiVideos)
                      if (event.target.checked) next.add(value.videoRel)
                      else next.delete(value.videoRel)
                      onSelectedAiVideosChange(next)
                    }}
                  />
                )
              }
            })
          ]
        : []),
      columnHelper.accessor((row) => row.source.name, {
        id: 'original',
        header: '原文件',
        size: 280,
        minSize: 180,
        cell: ({ row }) => {
          const value = row.original
          return (
            <span className="rename-editor-original" title={value.videoRel}>
              <b>{value.source.name}</b>
              <small>{value.videoRel}</small>
              {value.source.posterRelativePath && <em>关联 poster 会同步改名</em>}
            </span>
          )
        }
      }),
      columnHelper.accessor((row) => row.ruleSteps, {
        id: 'steps',
        header: '规则轨迹',
        size: 300,
        minSize: 180,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="rename-editor-steps">
            {row.original.ruleSteps.slice(0, 2).map((step, index) => (
              <span key={`${step.label}-${index}`} title={`${step.before} → ${step.after}`}>
                <b>{step.label}</b>
                <code>
                  {step.before} → {step.after}
                </code>
              </span>
            ))}
          </span>
        )
      }),
      columnHelper.accessor((row) => row.targetName, {
        id: 'target',
        header: '目标文件',
        size: 280,
        minSize: 180,
        cell: ({ row }) => {
          const value = row.original
          const isEditing = editingRel === value.videoRel
          return (
            <span className="rename-editor-target" onDoubleClick={() => beginEdit(value)}>
              {isEditing ? (
                <input
                  ref={editorInputRef}
                  value={draft}
                  aria-label={`编辑 ${value.source.name} 的目标词干`}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => commitEdit(value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitEdit(value)
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditingRel(null)
                      setDraft('')
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  disabled={value.targetExtension !== value.originalExtension || busy}
                  onClick={() => beginEdit(value)}
                  title="点击编辑目标名称"
                >
                  {value.targetName}
                </button>
              )}
              {value.manual && <em>已手动覆写</em>}
            </span>
          )
        }
      }),
      columnHelper.accessor((row) => row.risk, {
        id: 'riskRank',
        header: '状态',
        size: 240,
        minSize: 160,
        sortFn: (left, right) => {
          const rank = { conflict: 0, probe: 1, extension: 2, external: 3, none: 4 }
          return rank[left.original.risk] - rank[right.original.risk]
        },
        cell: ({ row }) => (
          <span className={`rename-editor-status ${row.original.risk}`}>
            <b>{statusText(row.original, probes[row.original.videoRel])}</b>
          </span>
        )
      }),
      columnHelper.display({
        id: 'actions',
        header: '操作',
        size: 116,
        minSize: 104,
        maxSize: 140,
        enableSorting: false,
        cell: ({ row }) => {
          const value = row.original
          return (
            <span className="rename-editor-actions">
              {value.manual && (
                <button type="button" onClick={() => onReset(value.videoRel)} disabled={busy}>
                  恢复计算值
                </button>
              )}
              {value.ai && (
                <button
                  type="button"
                  onClick={() => onRegenerate(value.videoRel)}
                  disabled={busy || regenerating === value.videoRel}
                >
                  {regenerating === value.videoRel ? '生成中…' : '重新生成'}
                </button>
              )}
            </span>
          )
        }
      })
    ],
    [
      beginEdit,
      busy,
      commitEdit,
      draft,
      editingRel,
      mode,
      onRegenerate,
      onReset,
      onSelectedAiVideosChange,
      probes,
      regenerating,
      selectedAiVideos
    ]
  ) as never

  const table = useTable(
    {
      features: renameTableFeatures,
      data: visibleRows,
      columns,
      getRowId: (row) => row.videoRel,
      state: { sorting },
      onSortingChange: setSorting,
      enableMultiSort: true,
      enableSortingRemoval: false,
      columnResizeMode: 'onChange',
      columnResizeDirection: 'ltr'
    },
    (state) => ({ sorting: state.sorting, columnSizing: state.columnSizing })
  )
  const sortedRows = table.getRowModel().rows
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pagedRows = sortedRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

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

      <div className="rename-table-wrap">
        <table className="rename-data-table" aria-label="文件名对照表">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort()
                  const sorted = header.column.getIsSorted()
                  return (
                    <th
                      key={header.id}
                      style={{ width: `${(header.getSize() / table.getTotalSize()) * 100}%` }}
                    >
                      {header.isPlaceholder ? null : (
                        <div className="rename-table-header-cell">
                          <button
                            type="button"
                            className="rename-table-sort"
                            disabled={!canSort}
                            onClick={header.column.getToggleSortingHandler()}
                            aria-label={
                              canSort
                                ? `按${String(header.column.columnDef.header)}排序`
                                : undefined
                            }
                          >
                            <table.FlexRender header={header} />
                            {canSort && (
                              <span aria-hidden="true">
                                {sorted === 'asc' ? '↑' : sorted === 'desc' ? '↓' : '↕'}
                              </span>
                            )}
                          </button>
                          {header.column.getCanResize() && (
                            <button
                              type="button"
                              className="rename-table-resize"
                              aria-label={`调整${String(header.column.columnDef.header)}列宽`}
                              onMouseDown={header.getResizeHandler()}
                              onTouchStart={header.getResizeHandler()}
                              onClick={(event) => event.stopPropagation()}
                            />
                          )}
                        </div>
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {pagedRows.map((row) => (
              <tr key={row.id} className={row.original.error ? 'invalid' : ''}>
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    style={{ width: `${(cell.column.getSize() / table.getTotalSize()) * 100}%` }}
                  >
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {sortedRows.length === 0 && <p className="rename-editor-empty">没有匹配的预览项。</p>}
      </div>

      {sortedRows.length > pageSize && (
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
