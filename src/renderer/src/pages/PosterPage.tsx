import { useEffect, useMemo, useRef, useState } from 'react'
import type { PosterVideoItem } from '../../../shared/types'
import ConfirmDialog from '../components/ConfirmDialog'
import { formatBytes } from '../utils/format'
import { mediaUrl } from '../utils/media'

function PosterPage({
  workspace,
  onChooseWorkspace
}: {
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [videos, setVideos] = useState<PosterVideoItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [detail, setDetail] = useState<PosterVideoItem | null>(null)
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

  const noPoster = useMemo(() => videos.filter((v) => !v.posterPath), [videos])

  const captureAll = async (): Promise<void> => {
    if (!workspace || noPoster.length === 0) return
    setCapturing(true)
    setError('')
    try {
      const { outcomes } = await window.api.capturePosters(
        workspace,
        noPoster.map((v) => v.relativePath)
      )
      const failed = outcomes.filter((o) => o.error)
      if (failed.length > 0) {
        setError(`${failed.length} 个视频截帧失败：${failed[0].relativePath} 等`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCapturing(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">模块四 · 封面管理</p>
          <h1>Poster 封面</h1>
          <p className="muted">
            无封面视频默认截取 5 张候选（10/30/50/70/90%），点击卡片进入详情手动选帧。
          </p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onChooseWorkspace} disabled={capturing}>
            选择工作区
          </button>
          <button
            className="secondary"
            onClick={refresh}
            disabled={!workspace || loading || capturing}
          >
            {loading ? '扫描中…' : '刷新列表'}
          </button>
          <button disabled={!workspace || capturing || noPoster.length === 0} onClick={captureAll}>
            {capturing ? '截帧中…' : `为无封面视频生成候选（${noPoster.length}）`}
          </button>
          {capturing && (
            <button className="secondary" onClick={() => window.api.cancelPosterCapture()}>
              取消
            </button>
          )}
        </div>
      </header>

      <section className="path-card">
        <span>当前工作区</span>
        <strong>{workspace || '尚未选择目录'}</strong>
      </section>

      {error && <section className="error-banner">{error}</section>}

      {!workspace && (
        <section className="empty">
          <h2>选择工作区后开始</h2>
          <p>扫描工作区内的视频并管理每个视频的封面图。</p>
        </section>
      )}
      {workspace && !loaded && !loading && (
        <section className="empty">
          <h2>准备扫描</h2>
          <p>点击「刷新列表」扫描工作区视频。</p>
        </section>
      )}
      {loaded && videos.length === 0 && (
        <section className="empty">
          <h2>没有发现视频</h2>
          <p>当前工作区内没有可识别的视频文件。</p>
        </section>
      )}

      {videos.length > 0 && (
        <section className="video-grid">
          {videos.map((video) => (
            <button
              key={video.relativePath}
              className="video-card"
              onClick={() => setDetail(video)}
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
                  {formatBytes(video.size)} · {video.posterPath ? '已有封面' : '无封面'}
                </span>
              </span>
            </button>
          ))}
        </section>
      )}

      {detail && (
        <PosterDetail
          key={detail.relativePath}
          video={detail}
          workspace={workspace}
          onClose={() => setDetail(null)}
          onSaved={async () => {
            setDetail(null)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

function PosterDetail({
  video,
  workspace,
  onClose,
  onSaved
}: {
  video: PosterVideoItem
  workspace: string
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [candidates, setCandidates] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(video.posterPath)
  // 无现存封面时初始即为 busy（挂载后自动生成 5 张候选）
  const [busy, setBusy] = useState(() => !video.posterPath)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (video.posterPath) return
    let alive = true
    window.api
      .capturePosters(workspace, [video.relativePath])
      .then(({ outcomes }) => {
        if (!alive) return
        const frames = outcomes[0]?.frames ?? []
        setCandidates(frames)
        if (frames.length > 0) setSelected(frames[0])
        if (outcomes[0]?.error) setError(outcomes[0].error)
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => alive && setBusy(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.relativePath])

  const captureCurrent = async (): Promise<void> => {
    const player = videoRef.current
    if (!player) return
    setBusy(true)
    setError('')
    try {
      const frame = await window.api.capturePosterAt(video.path, player.currentTime)
      setCandidates((prev) => [...prev, frame])
      setSelected(frame)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const allCandidates = useMemo(
    () => (video.posterPath ? [video.posterPath, ...candidates] : candidates),
    [video.posterPath, candidates]
  )

  const save = async (): Promise<void> => {
    if (!selected) return
    setConfirming(false)
    setBusy(true)
    setError('')
    try {
      await window.api.savePoster({
        videoPath: video.path,
        chosenFramePath: selected,
        oldPosterPath: video.posterPath
      })
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const needConfirm = !!video.posterPath && !!selected && selected !== video.posterPath

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="detail-modal" onClick={(event) => event.stopPropagation()}>
        <div className="detail-header">
          <b>{video.name}</b>
          <button className="chip-remove" onClick={onClose}>
            关闭
          </button>
        </div>
        <video ref={videoRef} src={mediaUrl(video.path)} controls className="detail-player" />
        <div className="detail-actions">
          <button className="secondary" disabled={busy} onClick={captureCurrent}>
            截取当前帧
          </button>
          <button
            disabled={!selected || busy}
            onClick={() => (needConfirm ? setConfirming(true) : save())}
          >
            {busy ? '处理中…' : '保存封面'}
          </button>
        </div>
        {error && <p className="danger-text">{error}</p>}
        <div className="candidate-strip">
          {busy && allCandidates.length === 0 && <p className="muted">正在截取候选帧…</p>}
          {allCandidates.map((frame) => (
            <button
              key={frame}
              className={`candidate ${selected === frame ? 'selected' : ''}`}
              onClick={() => setSelected(frame)}
            >
              <img src={mediaUrl(frame)} alt="候选帧" loading="lazy" />
              {frame === video.posterPath && <span className="candidate-tag">当前封面</span>}
            </button>
          ))}
        </div>
        {confirming && (
          <ConfirmDialog
            title="替换现有封面"
            deleteCount={1}
            deleteBytes={0}
            danger={false}
            extra={`保存后，旧封面与未选中的候选图将被永久删除，新封面保存为「${video.name.replace(/\.[^.]+$/, '')}-poster.jpg」。`}
            onConfirm={save}
            onCancel={() => setConfirming(false)}
          />
        )}
      </div>
    </div>
  )
}

export default PosterPage
