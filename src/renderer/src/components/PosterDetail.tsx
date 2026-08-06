import { useEffect, useRef, useState } from 'react'
import type { PosterVideoItem } from '../../../shared/types'
import ConfirmDialog from './ConfirmDialog'
import { mediaUrl } from '../utils/media'

function PosterDetail({
  video,
  workspace,
  candidates,
  selection,
  onSelect,
  onCandidates,
  onSaved,
  onClose
}: {
  video: PosterVideoItem
  workspace: string
  candidates: string[]
  selection: string | null
  onSelect: (frame: string) => void
  onCandidates: (frames: string[]) => void
  onSaved: (savedPath: string) => void
  onClose: () => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  // 无封面且无候选时初始即 busy（挂载后自动生成候选）
  const [busy, setBusy] = useState(() => !video.posterPath && candidates.length === 0)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')

  const generate = async (): Promise<string[]> => {
    const { outcomes } = await window.api.capturePosters(workspace, [video.relativePath])
    if (outcomes[0]?.error) throw new Error(outcomes[0].error)
    return outcomes[0]?.frames ?? []
  }

  useEffect(() => {
    // 无封面视频进入详情自动生成候选（有封面的由用户手动点"生成候选帧"）
    if (video.posterPath || candidates.length > 0) return
    let alive = true
    generate()
      .then((frames) => {
        if (!alive) return
        onCandidates(frames)
        if (frames[0]) onSelect(frames[0])
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
      onCandidates([...candidates, frame])
      onSelect(frame)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const frames = await generate()
      onCandidates(frames)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const dirty = !!selection && selection !== video.posterPath

  const save = async (): Promise<void> => {
    if (!selection || !dirty) return
    setConfirming(false)
    setBusy(true)
    setError('')
    try {
      const result = await window.api.savePoster({
        videoPath: video.path,
        chosenFramePath: selection,
        oldPosterPath: video.posterPath
      })
      onSaved(result.saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const allFrames = video.posterPath ? [video.posterPath, ...candidates] : candidates

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
          {video.posterPath && candidates.length === 0 && (
            <button className="secondary" disabled={busy} onClick={regenerate}>
              生成候选帧
            </button>
          )}
          <button className="secondary" disabled={busy} onClick={captureCurrent}>
            截取当前帧
          </button>
          <button
            disabled={!dirty || busy}
            onClick={() => (video.posterPath ? setConfirming(true) : save())}
          >
            {busy ? '处理中…' : dirty ? '保存封面' : '无改动'}
          </button>
        </div>
        {error && <p className="danger-text">{error}</p>}
        <div className="candidate-strip">
          {busy && allFrames.length === 0 && <p className="muted">正在截取候选帧…</p>}
          {allFrames.map((frame) => (
            <button
              key={frame}
              className={`candidate ${selection === frame ? 'selected' : ''}`}
              onClick={() => onSelect(frame)}
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

export default PosterDetail
