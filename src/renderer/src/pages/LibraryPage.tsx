import { useEffect, useMemo, useState } from 'react'
import type { LibraryDensity, MergeVideoItem, Orientation } from '../../../shared/types'
import ErrorBanner from '../components/ErrorBanner'
import VideoModal from '../components/VideoModal'
import VirtualGrid from '../components/VirtualGrid'
import { formatBytes, formatDuration } from '../utils/format'
import { mediaUrl } from '../utils/media'
import { useWorkspaceSync } from '../utils/useWorkspaceSync'

type SortKey = 'name' | 'size' | 'duration'
type OrientationFilter = 'all' | Orientation
type StatusFilter = 'all' | 'no-poster'

const DENSITY_OPTIONS: { key: LibraryDensity; label: string; minItemWidth: number }[] = [
  { key: 'comfortable', label: '舒展', minItemWidth: 280 },
  { key: 'standard', label: '标准', minItemWidth: 210 },
  { key: 'compact', label: '紧凑', minItemWidth: 164 }
]

/** 媒体库：海报墙 + 状态筛选 + 批量选择 + 点播（播放进度记忆）。只读视图。 */
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [density, setDensity] = useState<LibraryDensity>('standard')
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [playing, setPlaying] = useState<MergeVideoItem | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    window.api
      .getSettings()
      .then((settings) => setDensity(settings.libraryDensity ?? 'standard'))
      .catch(() => {})
  }, [])

  const refresh = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    setError('')
    try {
      const data = await window.api.scanMergeVideos(workspace)
      setVideos(data.videos)
      setSelectedPaths(new Set())
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useWorkspaceSync(workspace, active, refresh)

  const dashboard = useMemo(() => {
    const totalBytes = videos.reduce((sum, video) => sum + video.size, 0)
    const totalDuration = videos.reduce((sum, video) => sum + (video.media?.durationMs ?? 0), 0)
    const missingPoster = videos.filter((video) => !video.posterPath).length
    const portrait = videos.filter((video) => video.media?.orientation === 'portrait').length
    return { totalBytes, totalDuration, missingPoster, portrait }
  }, [videos])

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase()
    let list = videos
    if (key) list = list.filter((video) => video.name.toLowerCase().includes(key))
    if (orientation !== 'all')
      list = list.filter((video) => video.media?.orientation === orientation)
    if (statusFilter === 'no-poster') list = list.filter((video) => !video.posterPath)
    return [...list].sort((a, b) => {
      if (sortKey === 'size') return b.size - a.size
      if (sortKey === 'duration') return (b.media?.durationMs ?? 0) - (a.media?.durationMs ?? 0)
      return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
    })
  }, [videos, keyword, sortKey, orientation, statusFilter])

  const densityOption =
    DENSITY_OPTIONS.find((option) => option.key === density) ?? DENSITY_OPTIONS[1]
  const selectedVideos = useMemo(
    () => videos.filter((video) => selectedPaths.has(video.relativePath)),
    [selectedPaths, videos]
  )

  const updateDensity = (next: LibraryDensity): void => {
    setDensity(next)
    window.api.updateSettings({ libraryDensity: next }).catch(() => {})
  }

  const toggleSelected = (relativePath: string): void => {
    setSelectedPaths((previous) => {
      const next = new Set(previous)
      if (next.has(relativePath)) next.delete(relativePath)
      else next.add(relativePath)
      return next
    })
  }

  const selectFiltered = (): void =>
    setSelectedPaths(new Set(filtered.map((video) => video.relativePath)))

  const copySelectedPaths = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(selectedVideos.map((video) => video.path).join('\n'))
      setNotice(`已复制 ${selectedVideos.length} 个文件路径。`)
    } catch {
      setError('无法复制文件路径，请检查系统剪贴板权限。')
    }
  }

  return (
    <div className="page">
      <header className="page-header page-header-video">
        <div>
          <p className="eyebrow">视频工坊 / 媒体库</p>
          <h1>媒体库仪表盘</h1>
          <p className="muted">掌握容量、时长与整理缺口，再从海报墙浏览、筛选并播放视频。</p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onChooseWorkspace}>
            选择工作区
          </button>
          <button className="secondary" onClick={refresh} disabled={!workspace || loading}>
            {loading ? '加载中…' : '刷新媒体库'}
          </button>
        </div>
      </header>

      <section
        className="workspace-overview workspace-overview-video"
        aria-label="当前视频工作区概览"
      >
        <div className="workspace-overview-path">
          <span>当前工作区</span>
          <strong title={workspace || undefined}>{workspace || '尚未选择目录'}</strong>
        </div>
        <div className="workspace-overview-stat">
          <strong>{loaded ? videos.length : '—'}</strong>
          <span>视频素材</span>
        </div>
        <div className="workspace-overview-stat">
          <strong>{loaded ? formatBytes(dashboard.totalBytes) : '—'}</strong>
          <span>媒体容量</span>
        </div>
        <div
          className={`workspace-overview-stat ${dashboard.missingPoster > 0 ? 'needs-action' : ''}`}
        >
          <strong>{loaded ? dashboard.missingPoster : '—'}</strong>
          <span>待补封面</span>
        </div>
      </section>

      {error && <ErrorBanner message={error} />}
      {notice && (
        <p className="notice-inline" aria-live="polite">
          {notice}
        </p>
      )}

      {loading && !loaded && <LibrarySkeleton />}

      {loaded && videos.length > 0 && (
        <>
          <section className="stats library-dashboard" aria-label="媒体统计">
            <div>
              <span>视频总数</span>
              <b>{videos.length}</b>
            </div>
            <div>
              <span>媒体容量</span>
              <b>{formatBytes(dashboard.totalBytes)}</b>
            </div>
            <div>
              <span>总时长</span>
              <b>{formatDuration(dashboard.totalDuration)}</b>
            </div>
            <button
              className={`library-stat-action ${statusFilter === 'no-poster' ? 'active' : ''}`}
              onClick={() =>
                setStatusFilter((value) => (value === 'no-poster' ? 'all' : 'no-poster'))
              }
            >
              <span>待补封面</span>
              <b className={dashboard.missingPoster ? 'warning-text' : ''}>
                {dashboard.missingPoster}
              </b>
            </button>
            <button
              className={`library-stat-action ${orientation === 'portrait' ? 'active' : ''}`}
              onClick={() => setOrientation((value) => (value === 'portrait' ? 'all' : 'portrait'))}
            >
              <span>竖屏视频</span>
              <b>{dashboard.portrait}</b>
            </button>
          </section>
          {dashboard.missingPoster > 0 && (
            <section className="notice-banner">
              整理提醒：有 {dashboard.missingPoster}{' '}
              个视频尚无封面。可用下方筛选定位，再前往「封面管理」生成候选。
            </section>
          )}
          <div className="library-toolbar">
            <label className="library-search-field">
              <span className="sr-only">搜索视频</span>
              <input
                id="library-search"
                name="library-search"
                autoComplete="off"
                placeholder={`搜索 ${videos.length} 个视频…`}
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </label>
            <select
              aria-label="排序方式"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as SortKey)}
            >
              <option value="name">按名称</option>
              <option value="size">按大小</option>
              <option value="duration">按时长</option>
            </select>
            <div className="mode-tabs" aria-label="画面方向筛选">
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
            <div className="mode-tabs library-density-tabs" aria-label="海报墙密度">
              {DENSITY_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  className={`mode-tab ${density === option.key ? 'active' : ''}`}
                  onClick={() => updateDensity(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {(keyword || orientation !== 'all' || statusFilter !== 'all') && (
              <button
                className="secondary library-reset"
                onClick={() => {
                  setKeyword('')
                  setOrientation('all')
                  setStatusFilter('all')
                }}
              >
                清除筛选
              </button>
            )}
          </div>
          <div className="library-result-line" aria-live="polite">
            显示 {filtered.length} / {videos.length} 个视频
            {filtered.length > 0 && (
              <button className="text-button" onClick={selectFiltered}>
                全选当前结果
              </button>
            )}
          </div>
        </>
      )}

      {filtered.length > 0 && (
        <VirtualGrid
          className={`library-grid density-${density}`}
          items={filtered}
          minItemWidth={densityOption.minItemWidth}
          metaHeight={density === 'compact' ? 50 : 62}
          renderItem={(video, style) => (
            <article
              key={video.relativePath}
              className={`video-card ${selectedPaths.has(video.relativePath) ? 'selected' : ''}`}
              style={style}
            >
              <label className="poster-select">
                <input
                  type="checkbox"
                  checked={selectedPaths.has(video.relativePath)}
                  onChange={() => toggleSelected(video.relativePath)}
                  aria-label={`选择${video.name}`}
                />
              </label>
              <button className="video-card-open" onClick={() => setPlaying(video)}>
                <span className="video-thumb">
                  {video.posterPath ? (
                    <img
                      src={mediaUrl(video.posterPath)}
                      alt={video.name}
                      loading="lazy"
                      width="320"
                      height="180"
                    />
                  ) : (
                    <span className="video-thumb-empty" aria-label="暂无封面" />
                  )}
                  <span className="video-card-overlay" aria-hidden="true">
                    <b>
                      {video.media
                        ? `${video.media.width} × ${video.media.height}`
                        : '媒体信息待探测'}
                    </b>
                    <span>
                      {video.media?.videoCodec ?? '未知编码'} ·{' '}
                      {video.media ? `${video.media.fps.toFixed(0)} fps` : '—'}
                    </span>
                    <span>
                      {formatBytes(video.size)} ·{' '}
                      {video.media ? formatDuration(video.media.durationMs) : '—'}
                    </span>
                  </span>
                </span>
                <span className="video-meta">
                  <b title={video.name}>{video.name}</b>
                  <span className="muted">
                    {formatBytes(video.size)}
                    {video.media ? ` · ${formatDuration(video.media.durationMs)}` : ''}
                  </span>
                </span>
              </button>
            </article>
          )}
        />
      )}

      {loaded && videos.length > 0 && filtered.length === 0 && (
        <section className="empty">
          <h2>没有匹配的视频</h2>
          <p>调整搜索关键词或清除筛选条件后，再试一次。</p>
          <button
            className="secondary"
            onClick={() => {
              setKeyword('')
              setOrientation('all')
              setStatusFilter('all')
            }}
          >
            清除筛选
          </button>
        </section>
      )}
      {loaded && videos.length === 0 && (
        <section className="empty">
          <h2>媒体库为空</h2>
          <p>先用「NFO 归档」整理视频，这里就会变成海报墙。</p>
        </section>
      )}
      {!loaded && !loading && (
        <section className="empty">
          <h2>选择工作区后开始</h2>
          <p>指向已整理的工作区，点击「刷新媒体库」生成海报墙。</p>
        </section>
      )}

      {selectedVideos.length > 0 && (
        <aside className="library-selection-bar" aria-label="已选视频操作">
          <strong>已选择 {selectedVideos.length} 个视频</strong>
          <span>{formatBytes(selectedVideos.reduce((sum, video) => sum + video.size, 0))}</span>
          <div>
            <button className="secondary" onClick={() => setPlaying(selectedVideos[0])}>
              播放首项
            </button>
            <button className="secondary" onClick={() => void copySelectedPaths()}>
              复制路径
            </button>
            <button className="secondary" onClick={() => setSelectedPaths(new Set())}>
              取消选择
            </button>
          </div>
        </aside>
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

function LibrarySkeleton(): React.JSX.Element {
  return (
    <section className="library-skeleton" aria-label="正在加载媒体库" aria-busy="true">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <span key={index} />
      ))}
    </section>
  )
}

export default LibraryPage
