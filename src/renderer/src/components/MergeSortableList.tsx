import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { MergeVideoItem } from '../../../shared/types'
import { formatBytes } from '../utils/format'
import { mediaUrl } from '../utils/media'

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 合并片段拖拽排序列表（自由组合模式带勾选框） */
function MergeSortableList({
  items,
  selectable,
  selected,
  onToggle,
  onReorder
}: {
  items: MergeVideoItem[]
  selectable: boolean
  selected: Set<string>
  onToggle: (relativePath: string) => void
  onReorder: (next: MergeVideoItem[]) => void
}): React.JSX.Element {
  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = items.findIndex((item) => item.relativePath === active.id)
    const to = items.findIndex((item) => item.relativePath === over.id)
    onReorder(arrayMove(items, from, to))
  }

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext
        items={items.map((i) => i.relativePath)}
        strategy={verticalListSortingStrategy}
      >
        <div className="merge-list">
          {items.map((item, index) => (
            <SortableRow
              key={item.relativePath}
              item={item}
              index={index}
              selectable={selectable}
              checked={selected.has(item.relativePath)}
              onToggle={onToggle}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

function SortableRow({
  item,
  index,
  selectable,
  checked,
  onToggle
}: {
  item: MergeVideoItem
  index: number
  selectable: boolean
  checked: boolean
  onToggle: (relativePath: string) => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.relativePath
  })
  const media = item.media
  return (
    <div
      ref={setNodeRef}
      className={`merge-row ${isDragging ? 'dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span className="merge-drag" {...attributes} {...listeners}>
        ⠿
      </span>
      <span className="merge-order">{index + 1}</span>
      {selectable && (
        <input type="checkbox" checked={checked} onChange={() => onToggle(item.relativePath)} />
      )}
      <span className="merge-thumb">
        {item.posterPath ? (
          <img src={mediaUrl(item.posterPath)} alt="" loading="lazy" />
        ) : (
          <span className="video-thumb-empty">🎬</span>
        )}
      </span>
      <span className="merge-name" title={item.relativePath}>
        {item.name}
      </span>
      <span className="merge-info muted">
        {media
          ? `${formatDuration(media.durationMs)} · ${formatBytes(media.sizeBytes)} · ${media.width}×${media.height} · ${
              media.orientation === 'landscape' ? '横屏' : '竖屏'
            } · ${media.videoCodec ?? '?'}/${media.audioCodec ?? '无音轨'} · ${media.fps.toFixed(0)}fps`
          : '媒体信息读取失败'}
      </span>
    </div>
  )
}

export default MergeSortableList
