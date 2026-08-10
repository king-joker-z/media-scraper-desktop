import { useMemo, useState } from 'react'
import type { MergeVideoItem, Orientation } from '../../../shared/types'
import ErrorBanner from '../components/ErrorBanner'
import VideoModal from '../components/VideoModal'
import VirtualGrid from '../components/VirtualGrid'
import { formatBytes, formatDuration } from '../utils/format'
import { mediaUrl } from '../utils/media'
import { useWorkspaceSync } from '../utils/useWorkspaceSync'

type SortKey = 'name' | 'size' | 'duration'
type OrientationFilter = 'all' | Orientation

/** 媒体库：海报墙 + 排序/筛选/搜索 + 点播（播放进度记忆）。只读视图。 */
function LibraryPage({
  active,
  workspace,
  onChooseWorkspace
}: {
  active: boolean
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [videos, setVideos] = useState<MergeVideoItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [orientation, setOrientation] = useState<OrientationFilter>('all')
  const [playing, setPlaying] = useState<MergeVideoItem | null>(null)
  const [error, setError] = useState('')

  const refresh = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    setError('')
    try {
      // 复用合并扫描（带媒体信息 + 探测缓存，二次进入秒开）
      const data = await window.api.scanMergeVideos(workspace)
      setVideos(data.videos)
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // 页面可见时对比工作区指纹：有变化自动重扫
  useWorkspaceSync(workspace, active, refresh)

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase()
    let list = videos
    if (key) list = list.filter((v) => v.name.toLowerCase().includes(key))
    if (orientation !== 'all') list = list.filter((v) => v.media?.orientation === orientation)
    return [...list].sort((a, b) => {
      if (sortKey === 'size') return b.size - a.size
      if (sortKey === 'duration') return (b.media?.durationMs ?? 0) - (a.media?.durationMs ?? 0)
      return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
    })
  }, [videos, keyword, sortKey, orientation])

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">媒体库</p>
          <h1>媒体库浏览</h1>
          <p className="muted">海报墙浏览工作区视频，点击播放（自动记忆播放进度）。只读视图。</p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onChooseWorkspace}>
            选择工作区
          </button>
          <button className="secondary" onClick={refresh} disabled={!workspace || loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
      </header>

      <section className="path-card">
        <span>当前工作区</span>
        <strong>{workspace || '尚未选择目录'}</strong>
      </section>

      {error && <ErrorBanner message={error} />}

      {loaded && videos.length > 0 && (
        <div className="library-toolbar">
          <input
            placeholder={`搜索 ${videos.length} 个视频…`}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
            <option value="name">按名称</option>
            <option value="size">按大小</option>
            <option value="duration">按时长</option>
          </select>
          <div className="mode-tabs">
            {(
              [
                ['all', '全部'],
                ['landscape', '横屏'],
                ['portrait', '竖屏']
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={`mode-tab ${orientation === key ? 'active' : ''}`}
                onClick={() => setOrientation(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {filtered.length > 0 && (
        <VirtualGrid
          items={filtered}
          renderItem={(video, style) => (
            <button
              key={video.relativePath}
              className="video-card"
              style={style}
              onClick={() => setPlaying(video)}
            >
              <span className="video-thumb">
                {video.posterPath ? (
                  <img src={mediaUrl(video.posterPath)} alt={video.name} loading="lazy" />
                ) : (
                  <span className="video-thumb-empty">🎬</span>
                )}
              </span>
              <span className="video-meta">
                <b>{video.name}</b>
                <span className="muted">
                  {formatBytes(video.size)}
                  {video.media ? ` · ${formatDuration(video.media.durationMs)}` : ''}
                </span>
              </span>
            </button>
          )}
        />
      )}

      {loaded && videos.length === 0 && (
        <section className="empty">
          <h2>媒体库为空</h2>
          <p>先用「NFO 归档」整理视频，这里就会变成海报墙。</p>
        </section>
      )}
      {!loaded && (
        <section className="empty">
          <h2>选择工作区后开始</h2>
          <p>指向已整理的工作区，点击「刷新」生成海报墙。</p>
        </section>
      )}

      {playing && (
        <VideoModal
          path={playing.path}
          title={playing.name}
          rememberKey={playing.path}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  )
}

export default LibraryPage
