import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { useMemo } from 'react'
import { CSS } from '@dnd-kit/utilities'
import type { MergeVideoItem } from '../../../shared/types'
import { formatBytes, formatDuration } from '../utils/format'
import { usePalette } from '../hooks/usePalette'
import { mediaUrl } from '../utils/media'

/**
 * 合并片段列表：拖动 ⠿ 排序；点击右侧开关可将单个视频置灰排除（不参与本次合并），
 * 再次点击恢复。
 */
function MergeSortableList({
  items,
  excluded,
  onToggleExclude,
  onReorder,
  onPlay
}: {
  items: MergeVideoItem[]
  excluded: Set<string>
  onToggleExclude: (relativePath: string) => void
  onReorder: (next: MergeVideoItem[]) => void
  onPlay: (item: MergeVideoItem) => void
}): React.JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over) return
    if (active.id === over.id) return
    const from = items.findIndex((item) => item.relativePath === active.id)
    const to = items.findIndex((item) => item.relativePath === over.id)
    if (from < 0 || to < 0) return
    onReorder(arrayMove(items, from, to))
  }

  // 序号只给参与合并的片段（预先计算，避免渲染期变更）
  const orderMap = useMemo(() => {
    const map = new Map<string, number>()
    let counter = 0
    for (const item of items) {
      if (!excluded.has(item.relativePath)) {
        counter += 1
        map.set(item.relativePath, counter)
      }
    }
    return map
  }, [items, excluded])

  return (
    <DndContext collisionDetection={closestCenter} sensors={sensors} onDragEnd={handleDragEnd}>
      <SortableContext
        items={items.map((i) => i.relativePath)}
        strategy={verticalListSortingStrategy}
      >
        <div className="merge-list">
          {items.map((item) => (
            <SortableRow
              key={item.relativePath}
              item={item}
              order={orderMap.get(item.relativePath) ?? null}
              excluded={excluded.has(item.relativePath)}
              onToggleExclude={onToggleExclude}
              onPlay={onPlay}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

function SortableRow({
  item,
  order,
  excluded,
  onToggleExclude,
  onPlay
}: {
  item: MergeVideoItem
  order: number | null
  excluded: boolean
  onToggleExclude: (relativePath: string) => void
  onPlay: (item: MergeVideoItem) => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.relativePath
  })
  const media = item.media
  const palette = usePalette()

  /* 行内三段差异组件：序号尾标 / 信息读数 / 排除开关 */
  let orderChip: React.ReactNode = <span className="merge-order">{order ?? '—'}</span>
  let infoNode: React.ReactNode = (
    <span className="merge-info muted">
      {media
        ? `${formatDuration(media.durationMs)} · ${formatBytes(media.sizeBytes)} · ${media.width}×${media.height} · ${
            media.orientation === 'landscape' ? '横屏' : '竖屏'
          } · ${media.videoCodec ?? '?'}/${media.audioCodec ?? '无音轨'} · ${media.fps.toFixed(0)}fps`
        : '媒体信息读取失败'}
    </span>
  )
  let toggleLabel: string = excluded ? '已排除' : '参与'

  if (palette === 'terminal') {
    orderChip = (
      <span className="merge-order tv-order" aria-label={`合并顺序 ${order ?? '无'}`}>
        {order == null ? '--' : String(order).padStart(2, '0')}
      </span>
    )
    infoNode = (
      <span className="merge-info tv-info muted">
        {media
          ? `${formatDuration(media.durationMs)} // ${formatBytes(media.sizeBytes)} // ${media.width}×${media.height} // ${media.videoCodec?.toUpperCase() ?? '?'}/${media.audioCodec ?? '无音轨'} // ${media.fps.toFixed(0)}fps`
          : '媒体信息读取失败'}
      </span>
    )
    toggleLabel = excluded ? 'EXCLUDED' : 'IN-MERGE'
  } else if (palette === 'comic') {
    orderChip = <span className="merge-order cv-order">{order ?? '—'}</span>
  } else if (palette === 'comic-ukiyo') {
    orderChip = (
      <span className="merge-order uv-order" aria-hidden="true">
        {order == null ? '—' : order}
      </span>
    )
  }

  return (
    <div
      ref={setNodeRef}
      className={`merge-row ${isDragging ? 'dragging' : ''} ${excluded ? 'excluded' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="merge-drag"
        aria-label={`拖动排序：${item.name}`}
        title="拖动排序"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      {orderChip}
      <span className="merge-thumb">
        {item.posterPath ? (
          <img
            src={mediaUrl(item.posterPath)}
            alt=""
            width={media?.width ?? 160}
            height={media?.height ?? 90}
            loading="lazy"
          />
        ) : (
          <span className="video-thumb-empty" aria-label="暂无封面" />
        )}
      </span>
      <span className="merge-name" title={item.relativePath}>
        {item.name}
      </span>
      <button className="merge-play" title="试看" onClick={() => onPlay(item)}>
        ▶
      </button>
      {infoNode}
      <button
        className={`merge-toggle ${excluded ? 'off' : ''}`}
        title={excluded ? '恢复参与合并' : '置灰排除，不参与本次合并'}
        onClick={() => onToggleExclude(item.relativePath)}
      >
        {toggleLabel}
      </button>
    </div>
  )
}

export default MergeSortableList
