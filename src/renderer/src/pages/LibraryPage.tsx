import { useMemo, useState } from 'react'
import type { PosterVideoItem } from '../../../shared/types'
import VideoModal from '../components/VideoModal'
import { formatBytes } from '../utils/format'
import { mediaUrl } from '../utils/media'

/** 媒体库：归档后的海报墙 + 点击播放（只读，不做任何写操作） */
function LibraryPage({
  workspace,
  onChooseWorkspace
}: {
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [videos, setVideos] = useState<PosterVideoItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [playing, setPlaying] = useState<PosterVideoItem | null>(null)
  const [error, setError] = useState('')

  const refresh = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    setError('')
    try {
      setVideos(await window.api.listPosterVideos(workspace))
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase()
    if (!key) return videos
    return videos.filter((v) => v.name.toLowerCase().includes(key))
  }, [videos, keyword])

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">媒体库</p>
          <h1>媒体库浏览</h1>
          <p className="muted">海报墙浏览工作区内的视频，点击播放。只读视图。</p>
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

      {error && <section className="error-banner">{error}</section>}

      {loaded && videos.length > 0 && (
        <div className="library-toolbar">
          <input
            placeholder={`搜索 ${videos.length} 个视频…`}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </div>
      )}

      {filtered.length > 0 && (
        <section className="video-grid">
          {filtered.map((video) => (
            <button
              key={video.relativePath}
              className="video-card"
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
                <span className="muted">{formatBytes(video.size)}</span>
              </span>
            </button>
          ))}
        </section>
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
        <VideoModal path={playing.path} title={playing.name} onClose={() => setPlaying(null)} />
      )}
    </div>
  )
}

export default LibraryPage
