import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
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
  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = items.findIndex((item) => item.relativePath === active.id)
    const to = items.findIndex((item) => item.relativePath === over.id)
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
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
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
  return (
    <div
      ref={setNodeRef}
      className={`merge-row ${isDragging ? 'dragging' : ''} ${excluded ? 'excluded' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span className="merge-drag" {...attributes} {...listeners}>
        ⠿
      </span>
      <span className="merge-order">{order ?? '—'}</span>
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
      <button className="merge-play" title="试看" onClick={() => onPlay(item)}>
        ▶
      </button>
      <span className="merge-info muted">
        {media
          ? `${formatDuration(media.durationMs)} · ${formatBytes(media.sizeBytes)} · ${media.width}×${media.height} · ${
              media.orientation === 'landscape' ? '横屏' : '竖屏'
            } · ${media.videoCodec ?? '?'}/${media.audioCodec ?? '无音轨'} · ${media.fps.toFixed(0)}fps`
          : '媒体信息读取失败'}
      </span>
      <button
        className={`merge-toggle ${excluded ? 'off' : ''}`}
        title={excluded ? '恢复参与合并' : '置灰排除，不参与本次合并'}
        onClick={() => onToggleExclude(item.relativePath)}
      >
        {excluded ? '已排除' : '参与'}
      </button>
    </div>
  )
}

export default MergeSortableList
