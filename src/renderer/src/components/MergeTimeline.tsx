import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMemo } from 'react'
import type { MergeCompatibility, MergeVideoItem } from '../../../shared/types'
import { formatBytes, formatDuration } from '../utils/format'
import { mediaUrl } from '../utils/media'
import {
  buildTimelineSegments,
  orientationLabel,
  outputSpecLabel,
  timelineDurationMs,
  type TimelineSegment
} from './merge-timeline'

type ViewMode = 'list' | 'timeline'

function MergeTimeline({
  items,
  excluded,
  selectedPath,
  compatibility,
  estimatedBytes,
  freeBytes,
  onSelect,
  onPreview,
  onToggleExclude,
  onReorder
}: {
  items: MergeVideoItem[]
  excluded: Set<string>
  selectedPath: string | null
  compatibility: MergeCompatibility
  estimatedBytes: number
  freeBytes: number
  onSelect: (item: MergeVideoItem) => void
  onPreview: (item: MergeVideoItem) => void
  onToggleExclude: (relativePath: string) => void
  onReorder: (next: MergeVideoItem[]) => void
}): React.JSX.Element {
  const segments = useMemo(() => buildTimelineSegments(items, excluded), [items, excluded])
  const totalDuration = useMemo(() => timelineDurationMs(items, excluded), [items, excluded])
  const includedSegments = useMemo(() => segments.filter((segment) => segment.included), [segments])
  const excludedSegments = useMemo(
    () => segments.filter((segment) => !segment.included),
    [segments]
  )
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const reorder = (activeId: string, overId: string): void => {
    if (activeId === overId) return
    const activeInMainTrack = includedSegments.some(
      (segment) => segment.item.relativePath === activeId
    )
    const overInMainTrack = includedSegments.some((segment) => segment.item.relativePath === overId)
    // 两条轨道只负责各自排序；参与状态必须通过排除/恢复按钮明确切换。
    if (activeInMainTrack !== overInMainTrack) return

    const from = items.findIndex((item) => item.relativePath === activeId)
    const to = items.findIndex((item) => item.relativePath === overId)
    if (from < 0 || to < 0) return
    onReorder(arrayMove(items, from, to))
  }

  return (
    <section className="merge-timeline-workbench" aria-label="合并时间线拼贴台">
      <div className="merge-timeline-head">
        <div>
          <h2>拼贴时间线</h2>
          <p className="muted">片段宽度按真实时长比例排列。拖动片段即可调整同一轨道内的顺序。</p>
        </div>
        <div className="merge-timeline-total">
          <b>{formatDuration(totalDuration)}</b>
          <span>{includedSegments.length} 段参与输出</span>
        </div>
      </div>

      <DndContext
        collisionDetection={closestCenter}
        sensors={sensors}
        onDragEnd={({ active, over }) => {
          if (!over) return
          reorder(String(active.id), String(over.id))
        }}
      >
        <SortableContext
          items={includedSegments.map((segment) => segment.item.relativePath)}
          strategy={horizontalListSortingStrategy}
        >
          <div className="merge-timeline-scroll">
            <div
              className={`merge-timeline-track ${includedSegments.length > 120 ? 'dense' : ''}`}
              role="list"
              aria-label="参与本次输出的片段"
            >
              {includedSegments.map((segment) => (
                <TimelineClip
                  key={segment.item.relativePath}
                  segment={segment}
                  dense={includedSegments.length > 120}
                  selected={selectedPath === segment.item.relativePath}
                  onSelect={onSelect}
                  onPreview={onPreview}
                  onToggleExclude={onToggleExclude}
                />
              ))}
            </div>
          </div>
        </SortableContext>
        {excludedSegments.length > 0 && (
          <SortableContext
            items={excludedSegments.map((segment) => segment.item.relativePath)}
            strategy={horizontalListSortingStrategy}
          >
            <section
              className="merge-timeline-excluded-rail"
              aria-label={`本次不参与的 ${excludedSegments.length} 个片段`}
            >
              <div className="merge-timeline-excluded-title">
                <b>本次不参与（{excludedSegments.length}）</b>
                <span>不占用输出时间线；可恢复参与或调整旁路顺序</span>
              </div>
              <div className="merge-timeline-excluded-items" role="list">
                {excludedSegments.map((segment) => (
                  <TimelineClip
                    key={segment.item.relativePath}
                    segment={segment}
                    dense={false}
                    selected={selectedPath === segment.item.relativePath}
                    onSelect={onSelect}
                    onPreview={onPreview}
                    onToggleExclude={onToggleExclude}
                  />
                ))}
              </div>
            </section>
          </SortableContext>
        )}
      </DndContext>

      <div className="merge-output-strip" aria-label="输出规格摘要">
        <span>
          <b>输出规格</b>
          {outputSpecLabel(compatibility)}
        </span>
        <span>
          <b>预计大小</b>
          {formatBytes(estimatedBytes)} / 可用 {formatBytes(freeBytes)}
        </span>
        {!compatibility.compatible && compatibility.target && (
          <span className="merge-output-warning">
            将统一转码。混合横竖屏时输出采用{' '}
            {compatibility.target.width >= compatibility.target.height ? '横屏' : '竖屏'}
            画布，另一方向等比补边。
          </span>
        )}
      </div>
    </section>
  )
}

function TimelineClip({
  segment,
  dense,
  selected,
  onSelect,
  onPreview,
  onToggleExclude
}: {
  segment: TimelineSegment
  dense: boolean
  selected: boolean
  onSelect: (item: MergeVideoItem) => void
  onPreview: (item: MergeVideoItem) => void
  onToggleExclude: (relativePath: string) => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: segment.item.relativePath
  })
  const { item } = segment
  const duration = item.media?.durationMs ?? 0
  const orientation = orientationLabel(item)
  const excluded = !segment.included
  const clipLabel = `第 ${segment.index + 1} 段，${item.name}，${formatDuration(duration)}，${orientation}，${excluded ? '未参与输出' : '参与输出'}`

  return (
    <article
      ref={setNodeRef}
      className={`merge-timeline-clip ${orientation === '竖屏' ? 'portrait' : 'landscape'} ${excluded ? 'excluded' : ''} ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''}`}
      style={{
        flexGrow: segment.widthWeight,
        flexBasis: segment.included ? 0 : '72px',
        transform: CSS.Transform.toString(transform),
        transition
      }}
      role="listitem"
    >
      <button
        className="merge-timeline-clip-main"
        aria-label={clipLabel}
        title={`${item.relativePath}\n${item.media ? `${item.media.width}×${item.media.height} · ${item.media.videoCodec ?? '未知'} / ${item.media.audioCodec ?? '无音轨'}` : '媒体信息读取失败'}`}
        onClick={() => {
          onSelect(item)
          if (!dense) onPreview(item)
        }}
        onKeyDown={(event) => {
          if (event.key === ' ') {
            event.preventDefault()
            onSelect(item)
            if (!dense) onPreview(item)
          }
        }}
      >
        <span className="merge-timeline-frame" aria-hidden="true">
          {item.posterPath ? (
            <img
              src={mediaUrl(item.posterPath)}
              alt=""
              width={item.media?.width ?? 160}
              height={item.media?.height ?? 90}
              loading="lazy"
            />
          ) : (
            <span />
          )}
        </span>
        <span className="merge-timeline-overlay">
          <b>{segment.index + 1}</b>
          <small>{formatDuration(duration)}</small>
        </span>
        <span className="merge-timeline-name">{item.name}</span>
        <span className="merge-timeline-meta">{orientation}</span>
      </button>
      <button
        className="merge-timeline-drag"
        aria-label={`移动第 ${segment.index + 1} 段：${item.name}`}
        title="拖动排序"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <button
        className="merge-timeline-exclude"
        aria-label={
          excluded ? `恢复第 ${segment.index + 1} 段参与输出` : `排除第 ${segment.index + 1} 段`
        }
        onClick={() => onToggleExclude(item.relativePath)}
      >
        {excluded ? '恢复' : '排除'}
      </button>
    </article>
  )
}

export function MergeViewToggle({
  value,
  onChange
}: {
  value: ViewMode
  onChange: (value: ViewMode) => void
}): React.JSX.Element {
  return (
    <div className="merge-view-toggle" role="group" aria-label="片段展示方式">
      <button
        className={value === 'list' ? 'active' : 'secondary'}
        onClick={() => onChange('list')}
      >
        列表
      </button>
      <button
        className={value === 'timeline' ? 'active' : 'secondary'}
        onClick={() => onChange('timeline')}
      >
        时间线
      </button>
    </div>
  )
}

export default MergeTimeline
