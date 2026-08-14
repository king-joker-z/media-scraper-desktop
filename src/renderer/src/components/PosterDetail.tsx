import { useRef, useState } from 'react'
import type { CandidateFrameScore, PosterVideoItem } from '../../../shared/types'
import ConfirmDialog from './ConfirmDialog'
import { mediaUrl } from '../utils/media'

function PosterDetail({
  video,
  workspace,
  candidates,
  scores,
  selection,
  version,
  onSelect,
  onCandidates,
  onSaved,
  onClose
}: {
  video: PosterVideoItem
  workspace: string
  candidates: string[]
  scores: CandidateFrameScore[]
  selection: string | null
  /** 封面保存版本号，用于破除图片缓存 */
  version: number
  onSelect: (frame: string) => void
  onCandidates: (frames: string[], scores?: CandidateFrameScore[]) => void
  onSaved: (savedPath: string) => void
  onClose: () => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  // 详情页只展示已有候选；批量截帧失败后不得自动重试并锁住手动截帧。
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')

  const generate = async (): Promise<{ frames: string[]; scores: CandidateFrameScore[] }> => {
    const { outcomes } = await window.api.capturePosters(workspace, [video.relativePath])
    if (outcomes[0]?.error) throw new Error(outcomes[0].error)
    return { frames: outcomes[0]?.frames ?? [], scores: outcomes[0]?.scores ?? [] }
  }

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
      const { frames, scores: nextScores } = await generate()
      onCandidates(frames, nextScores)
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
  const scoreFor = (frame: string): CandidateFrameScore | undefined =>
    scores.find((entry) => entry.path === frame)

  // 截帧详情关闭时主动断开播放器，Windows 才能立即释放视频文件锁。
  const close = (): void => {
    const player = videoRef.current
    if (player) {
      player.pause()
      player.removeAttribute('src')
      player.load()
    }
    onClose()
  }

  return (
    <div className="dialog-overlay" onClick={close}>
      <div
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`封面详情：${video.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="detail-header">
          <b>{video.name}</b>
          <button className="chip-remove" aria-label="关闭封面详情" onClick={close}>
            关闭
          </button>
        </div>
        <video ref={videoRef} src={mediaUrl(video.path)} controls className="detail-player" />
        <div className="detail-actions">
          {candidates.length === 0 && (
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
              <img src={`${mediaUrl(frame)}?v=${version}`} alt="候选帧" loading="lazy" />
              {frame === video.posterPath ? (
                <span className="candidate-tag">当前封面</span>
              ) : (
                scoreFor(frame) && (
                  <span className="candidate-tag">质量 {scoreFor(frame)!.score}</span>
                )
              )}
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
