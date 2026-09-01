import { useEffect, useMemo, useState } from 'react'
import { compareTitles } from '../../../shared/rename-rules.mjs'
import type { LibraryDensity, MergeVideoItem, Orientation } from '../../../shared/types'
import ErrorBanner from '../components/ErrorBanner'
import StatGrid from '../components/StatGrid'
import VideoModal from '../components/VideoModal'
import VirtualGrid from '../components/VirtualGrid'
import StatusBadge from '../components/StatusBadge'
import WorkbenchEmptyState from '../components/WorkbenchEmptyState'
import WorkbenchHeader from '../components/WorkbenchHeader'
import { usePalette } from '../hooks/usePalette'
import { formatBytes, formatDuration } from '../utils/format'
import { mediaUrl } from '../utils/media'
import { useWorkspaceSync } from '../utils/useWorkspaceSync'
import { useWorkspaceRequestVersion } from '../utils/useWorkspaceRequestVersion'

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
  const requests = useWorkspaceRequestVersion(workspace)

  useEffect(() => {
    window.api
      .getSettings()
      .then((settings) => setDensity(settings.libraryDensity ?? 'standard'))
      .catch(() => {})
  }, [])

  const refresh = async (): Promise<void> => {
    if (!workspace) return
    const requestWorkspace = workspace
    const requestVersion = requests.begin()
    setLoading(true)
    setError('')
    try {
      const data = await window.api.scanMergeVideos(workspace)
      if (!requests.isCurrent(requestVersion, requestWorkspace)) return
      setVideos(data.videos)
      setSelectedPaths(new Set())
      setLoaded(true)
    } catch (err) {
      if (requests.isCurrent(requestVersion, requestWorkspace))
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requests.isCurrent(requestVersion, requestWorkspace)) setLoading(false)
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
      if (sortKey === 'size') return b.size - a.size || compareTitles(a.name, b.name)
      if (sortKey === 'duration')
        return (
          (b.media?.durationMs ?? 0) - (a.media?.durationMs ?? 0) || compareTitles(a.name, b.name)
        )
      return compareTitles(a.name, b.name)
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
      <WorkbenchHeader
        eyebrow="视频工坊 / 素材浏览"
        title="媒体库"
        description="在海报墙中浏览、筛选与播放视频，并快速定位需要补充封面的素材。"
        actions={
          <>
            <button className="secondary" onClick={onChooseWorkspace}>
              选择工作区
            </button>
            <button data-command="scan" onClick={refresh} disabled={!workspace || loading}>
              {loading ? '加载中…' : '刷新媒体库'}
            </button>
          </>
        }
      />

      <section
        className="workbench-overview workspace-overview workspace-overview-video"
        aria-label="当前视频工作区概览"
      >
        <div className="workspace-overview-path">
          <span>当前工作区</span>
          <strong title={workspace || undefined}>{workspace || '尚未选择目录'}</strong>
        </div>
        <div className="workspace-overview-stat">
          <span>视频素材</span>
          <strong>{loaded ? videos.length : '—'}</strong>
        </div>
        <div className="workspace-overview-stat">
          <span>媒体容量</span>
          <strong>{loaded ? formatBytes(dashboard.totalBytes) : '—'}</strong>
        </div>
        <div
          className={`workspace-overview-stat ${dashboard.missingPoster > 0 ? 'needs-action' : ''}`}
        >
          <span>整理状态</span>
          <StatusBadge tone={dashboard.missingPoster > 0 ? 'warning' : 'success'}>
            {loaded
              ? dashboard.missingPoster > 0
                ? `${dashboard.missingPoster} 个待补封面`
                : '封面完整'
              : '等待扫描'}
          </StatusBadge>
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
          <StatGrid
            className="library-dashboard"
            ariaLabel="媒体统计"
            items={[
              { label: '视频总数', value: videos.length },
              { label: '媒体容量', value: formatBytes(dashboard.totalBytes) },
              { label: '总时长', value: formatDuration(dashboard.totalDuration) },
              {
                label: '待补封面',
                value: dashboard.missingPoster,
                valueClassName: dashboard.missingPoster ? 'warning-text' : undefined,
                active: statusFilter === 'no-poster',
                onSelect: () =>
                  setStatusFilter((value) => (value === 'no-poster' ? 'all' : 'no-poster'))
              },
              {
                label: '竖屏视频',
                value: dashboard.portrait,
                active: orientation === 'portrait',
                onSelect: () =>
                  setOrientation((value) => (value === 'portrait' ? 'all' : 'portrait'))
              }
            ]}
          />
          {dashboard.missingPoster > 0 && (
            <section className="notice-banner">
              整理提醒：有 {dashboard.missingPoster}{' '}
              个视频尚无封面。可用下方筛选定位，再前往「封面管理」生成候选。
            </section>
          )}
          <div className="library-toolbar workbench-toolbar">
            <label className="library-search-field">
              <input
                id="library-search"
                name="library-search"
                aria-label="搜索视频"
                autoComplete="off"
                placeholder={`搜索视频（共 ${videos.length} 个）`}
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </label>
            <select
              className="library-sort-select"
              aria-label="排序方式"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as SortKey)}
            >
              <option value="name">按名称</option>
              <option value="size">按大小</option>
              <option value="duration">按时长</option>
            </select>
            <div className="mode-tabs library-filter-tabs" aria-label="画面方向筛选">
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
            <LibraryVideoCard
              key={video.relativePath}
              video={video}
              style={style}
              selected={selectedPaths.has(video.relativePath)}
              onToggleSelect={() => toggleSelected(video.relativePath)}
              onOpen={() => setPlaying(video)}
            />
          )}
        />
      )}

      {loaded && videos.length > 0 && filtered.length === 0 && (
        <WorkbenchEmptyState
          title="没有匹配的视频"
          description="调整搜索关键词或清除筛选条件后，再试一次。"
          action={
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
          }
        />
      )}
      {loaded && videos.length === 0 && (
        <WorkbenchEmptyState
          title="媒体库为空"
          description="先整理或归档视频素材，扫描后这里会成为可筛选的海报墙。"
        />
      )}
      {!loaded && !loading && (
        <WorkbenchEmptyState
          title="选择工作区后开始"
          description="指向已整理的工作区，扫描后即可生成可浏览的海报墙。"
        />
      )}

      {selectedVideos.length > 0 && (
        <aside className="library-selection-bar workbench-selection-bar" aria-label="已选视频操作">
          <strong>已选择 {selectedVideos.length} 个视频</strong>
          <span>{formatBytes(selectedVideos.reduce((sum, video) => sum + video.size, 0))}</span>
          <div>
            <button onClick={() => setPlaying(selectedVideos[0])}>播放首项</button>
            <button className="secondary" onClick={() => void copySelectedPaths()}>
              复制路径
            </button>
            <button className="secondary action-cancel" onClick={() => setSelectedPaths(new Set())}>
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

/** 媒体库卡片：默认皮肤沿用原有海报卡 DOM；terminal 换成片场监视卡。 */
function LibraryVideoCard({
  video,
  style,
  selected,
  onToggleSelect,
  onOpen
}: {
  video: MergeVideoItem
  style: React.CSSProperties
  selected: boolean
  onToggleSelect: () => void
  onOpen: () => void
}): React.JSX.Element {
  const palette = usePalette()

  if (palette === 'terminal') {
    return (
      <article className={`video-card terminal-view ${selected ? 'selected' : ''}`} style={style}>
        <button className="video-card-open tv-frame" onClick={onOpen}>
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
            <span className="tv-timecode" aria-hidden="true">
              {video.media ? formatDuration(video.media.durationMs) : '--:--'}
            </span>
            <span className="tv-res" aria-hidden="true">
              {video.media ? `${video.media.width}×${video.media.height}` : 'PROBE'}
            </span>
            <span className="tv-playglyph" aria-hidden="true">
              ▶
            </span>
          </span>
        </button>
        <label className="poster-select tv-select">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`选择${video.name}`}
          />
        </label>
        <div className="tv-meta">
          <b title={video.name}>{video.name}</b>
          <span className="tv-read">
            {formatBytes(video.size)} {'//'} {video.media?.videoCodec?.toUpperCase() ?? 'PROBE'}{' '}
            {'//'} {video.media ? `${video.media.fps.toFixed(0)}FPS` : '—'}
          </span>
        </div>
      </article>
    )
  }

  if (palette === 'comic') {
    /* 漫画风：粗黑边框分镜卡 + 點心黄时间片 + 悬停加速线 + 硬态悬停条 */
    return (
      <article className={`video-card comic-view ${selected ? 'selected' : ''}`} style={style}>
        <button className="video-card-open cv-frame" onClick={onOpen}>
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
            <span className="cv-speedlines" aria-hidden="true" />
            <span className="cv-time" aria-hidden="true">
              {video.media ? formatDuration(video.media.durationMs) : '--:--'}
            </span>
            <span className="cv-play" aria-hidden="true">
              ▶
            </span>
          </span>
        </button>
        <label className="poster-select cv-select">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`选择${video.name}`}
          />
        </label>
        <div className="cv-caption">
          <b title={video.name}>{video.name}</b>
          <span className="cv-read">
            {formatBytes(video.size)} ★ {video.media?.videoCodec?.toUpperCase() ?? 'PROBE'} ★{' '}
            {video.media ? `${video.media.fps.toFixed(0)}FPS` : '—'}
          </span>
        </div>
      </article>
    )
  }

  if (palette === 'comic-ukiyo') {
    /* 浮世绘卷：和纸框边 + 靛蓝内框 + 选中盖朱印 */
    return (
      <article className={`video-card ukiyo-view ${selected ? 'selected' : ''}`} style={style}>
        <button className="video-card-open uv-frame" onClick={onOpen}>
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
            <span className="uv-time" aria-hidden="true">
              {video.media ? formatDuration(video.media.durationMs) : '--:--'}
            </span>
          </span>
        </button>
        <label className="poster-select uv-select">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`选择${video.name}`}
          />
        </label>
        <div className="uv-caption">
          <b title={video.name}>{video.name}</b>
          <span className="uv-read">
            {formatBytes(video.size)} ／ {video.media?.videoCodec ?? '未知编码'} ／{' '}
            {video.media ? `${video.media.fps.toFixed(0)} fps` : '—'}
          </span>
        </div>
        {selected && (
          <span className="uv-seal" aria-hidden="true">
            选
          </span>
        )}
      </article>
    )
  }

  return (
    <article className={`video-card ${selected ? 'selected' : ''}`} style={style}>
      <label className="poster-select">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`选择${video.name}`}
        />
      </label>
      <button className="video-card-open" onClick={onOpen}>
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
            <b>{video.media ? `${video.media.width} × ${video.media.height}` : '媒体信息待探测'}</b>
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
  )
}

export default LibraryPage
