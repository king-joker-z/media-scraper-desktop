import * as Tooltip from '@radix-ui/react-tooltip'
import { useMemo, useRef, useState } from 'react'
import type { CandidateFrameScore } from '../../../shared/types'
import HoverImagePreview from './HoverImagePreview'
import { formatDuration } from '../utils/format'
import { mediaUrl } from '../utils/media'

type SortMode = 'recommended' | 'time' | 'scene' | 'similar'

interface ContactFrame {
  path: string
  score?: CandidateFrameScore
  current: boolean
}

function labelFor(frame: ContactFrame): string {
  const score = frame.score
  if (frame.current) return '当前封面'
  if (score?.manual) return '手动截取'
  if (score?.rejected) return '不推荐：纯色背景'
  if (score?.sceneCut) return '场景变化'
  return `质量 ${Math.round(score?.score ?? 0)}`
}

function PosterContactSheet({
  frames,
  selection,
  version,
  onSelect,
  onSeek,
  onTogglePlayback,
  onSave,
  onClose,
  onInspect
}: {
  frames: ContactFrame[]
  selection: string | null
  version: number
  onSelect: (frame: string) => void
  onSeek: (timestampMs: number) => Promise<void>
  onTogglePlayback: () => void
  onSave: () => void
  onClose: () => void
  onInspect: (frame: string) => void
}): React.JSX.Element {
  const [sortMode, setSortMode] = useState<SortMode>('recommended')
  const [collapseSimilar, setCollapseSimilar] = useState(true)
  const [activePath, setActivePath] = useState<string | null>(selection ?? frames[0]?.path ?? null)
  const [seekingPath, setSeekingPath] = useState<string | null>(null)
  const [positionedPath, setPositionedPath] = useState<string | null>(null)
  const seekRequestRef = useRef(0)
  const gridRef = useRef<HTMLDivElement>(null)

  const orderedFrames = useMemo(() => {
    const sorted = [...frames]
    if (sortMode === 'time') {
      sorted.sort((left, right) => (left.score?.timestampMs ?? 0) - (right.score?.timestampMs ?? 0))
    } else if (sortMode === 'scene') {
      sorted.sort(
        (left, right) =>
          Number(Boolean(right.score?.sceneCut)) - Number(Boolean(left.score?.sceneCut)) ||
          (right.score?.score ?? 0) - (left.score?.score ?? 0)
      )
    } else if (sortMode === 'similar') {
      sorted.sort(
        (left, right) =>
          (left.score?.similarityGroup ?? Number.MAX_SAFE_INTEGER) -
            (right.score?.similarityGroup ?? Number.MAX_SAFE_INTEGER) ||
          (right.score?.score ?? 0) - (left.score?.score ?? 0)
      )
    } else {
      sorted.sort((left, right) => (right.score?.score ?? 0) - (left.score?.score ?? 0))
    }
    if (!collapseSimilar) return sorted
    const seenGroups = new Set<number>()
    return sorted.filter((frame) => {
      const group = frame.score?.similarityGroup
      if (!group || seenGroups.has(group)) return !group
      seenGroups.add(group)
      return true
    })
  }, [collapseSimilar, frames, sortMode])

  const activeFramePath = orderedFrames.some((frame) => frame.path === activePath)
    ? activePath
    : (orderedFrames[0]?.path ?? null)

  const activate = async (frame: ContactFrame): Promise<void> => {
    const requestId = seekRequestRef.current + 1
    seekRequestRef.current = requestId
    setActivePath(frame.path)
    setPositionedPath(null)
    onSelect(frame.path)
    if (typeof frame.score?.timestampMs !== 'number') {
      setSeekingPath(null)
      return
    }
    setSeekingPath(frame.path)
    try {
      await onSeek(frame.score.timestampMs)
      if (seekRequestRef.current === requestId) setPositionedPath(frame.path)
    } catch {
      if (seekRequestRef.current === requestId) setPositionedPath(null)
    } finally {
      if (seekRequestRef.current === requestId) setSeekingPath(null)
    }
  }

  const moveFocus = (direction: 'left' | 'right' | 'up' | 'down'): void => {
    const current = Math.max(
      0,
      orderedFrames.findIndex((frame) => frame.path === activeFramePath)
    )
    const columns = Math.max(
      1,
      Number.parseInt(
        getComputedStyle(gridRef.current ?? document.documentElement).getPropertyValue(
          '--contact-columns'
        ),
        10
      ) || 3
    )
    const delta =
      direction === 'left'
        ? -1
        : direction === 'right'
          ? 1
          : direction === 'up'
            ? -columns
            : columns
    const next = orderedFrames[Math.min(orderedFrames.length - 1, Math.max(0, current + delta))]
    if (!next) return
    setActivePath(next.path)
    requestAnimationFrame(() => {
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-frame-path="${CSS.escape(next.path)}"]`)
        ?.focus()
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget && !(event.target instanceof HTMLButtonElement)) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      moveFocus('left')
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      moveFocus('right')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus('up')
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveFocus('down')
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const frame = orderedFrames.find((item) => item.path === activeFramePath)
      if (frame) void activate(frame)
    } else if (event.key === ' ') {
      event.preventDefault()
      onTogglePlayback()
    } else if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      onSave()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const groupCount = new Map<number, number>()
  for (const frame of frames) {
    if (frame.score?.similarityGroup) {
      const group = frame.score.similarityGroup
      groupCount.set(group, (groupCount.get(group) ?? 0) + 1)
    }
  }

  return (
    <section className="poster-contact-sheet" aria-label="候选封面接触表">
      <div className="contact-sheet-toolbar">
        <div className="contact-sheet-summary">
          <b>候选接触表</b>
          <span>
            {collapseSimilar
              ? `${orderedFrames.length} 个代表帧`
              : `${orderedFrames.length} 个候选帧`}
          </span>
        </div>
        <div className="contact-sheet-controls">
          <label>
            <span className="sr-only">排序方式</span>
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
            >
              <option value="recommended">推荐优先</option>
              <option value="time">时间顺序</option>
              <option value="scene">场景优先</option>
              <option value="similar">相似分组</option>
            </select>
          </label>
          <label className="contact-sheet-switch">
            <input
              type="checkbox"
              checked={collapseSimilar}
              onChange={(event) => setCollapseSimilar(event.target.checked)}
            />
            合并相似帧
          </label>
        </div>
      </div>

      {orderedFrames.length === 0 ? (
        <p className="muted contact-sheet-empty">尚无候选帧。生成候选或在播放器定位后手动截取。</p>
      ) : (
        <div
          ref={gridRef}
          className="contact-sheet-grid"
          role="grid"
          aria-label="候选封面网格，可用方向键移动，Enter 选择，空格播放或暂停，S 保存"
          onKeyDown={onKeyDown}
        >
          {orderedFrames.map((frame) => {
            const groupSize = frame.score?.similarityGroup
              ? (groupCount.get(frame.score.similarityGroup) ?? 1)
              : 1
            const isSelected = frame.path === selection
            const isActive = frame.path === activeFramePath
            const timestamp = frame.score?.timestampMs
            const similarityDistance = frame.score?.similarityDistance
            const similarityLabel =
              !collapseSimilar && groupSize > 1 && typeof similarityDistance === 'number'
                ? `，与代表帧差异 ${similarityDistance}/64`
                : ''
            const caption =
              seekingPath === frame.path
                ? '定位中…'
                : positionedPath === frame.path
                  ? '已定位'
                  : labelFor(frame)
            return (
              <button
                key={frame.path}
                type="button"
                role="gridcell"
                data-frame-path={frame.path}
                tabIndex={isActive ? 0 : -1}
                className={`contact-frame ${isSelected ? 'selected' : ''} ${frame.current ? 'current' : ''}`}
                aria-label={`${labelFor(frame)}${typeof timestamp === 'number' ? `，时间 ${formatDuration(timestamp)}` : ''}${groupSize > 1 ? `，相似组共 ${groupSize} 帧` : ''}${similarityLabel}`}
                onFocus={() => setActivePath(frame.path)}
                onClick={() => void activate(frame)}
                onDoubleClick={() => onInspect(frame.path)}
              >
                <HoverImagePreview
                  src={`${mediaUrl(frame.path)}?v=${version}`}
                  alt={`${labelFor(frame)} 完整预览`}
                >
                  <span className="contact-frame-thumbnail">
                    <img src={`${mediaUrl(frame.path)}?v=${version}`} alt="" loading="lazy" />
                  </span>
                </HoverImagePreview>
                <span className="contact-frame-topline">
                  {typeof timestamp === 'number' && <span>{formatDuration(timestamp)}</span>}
                  {groupSize > 1 && (
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <span>相似 {groupSize}</span>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content className="app-tooltip" sideOffset={6}>
                          当前候选与 {groupSize - 1} 张相近帧归为一组
                          <Tooltip.Arrow className="app-tooltip-arrow" />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  )}
                  {!collapseSimilar && groupSize > 1 && typeof similarityDistance === 'number' && (
                    <span>差异 {similarityDistance}/64</span>
                  )}
                </span>
                <span className="contact-frame-caption">{caption}</span>
                {isSelected && <span className="contact-frame-selection">已选择</span>}
              </button>
            )
          })}
        </div>
      )}
      <p className="contact-sheet-help">
        悬停完整预览 · 双击细节检查 · 方向键浏览 · Enter 选择 · Space 播放/暂停 · S 保存 · Escape
        关闭
      </p>
    </section>
  )
}

export default PosterContactSheet
