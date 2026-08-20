import { useEffect, useRef, useState } from 'react'
import type { CandidateFrameScore, PosterVideoItem } from '../../../shared/types'
import ConfirmDialog from './ConfirmDialog'
import PosterContactSheet from './PosterContactSheet'
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
  // 候选生成与手动截帧是独立操作：候选失败/耗时不能锁住用户在播放器当前时点截帧。
  const [generating, setGenerating] = useState(false)
  const [capturingCurrent, setCapturingCurrent] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const player = videoRef.current
      if (player) {
        player.pause()
        player.removeAttribute('src')
        player.load()
      }
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const generate = async (): Promise<{ frames: string[]; scores: CandidateFrameScore[] }> => {
    const { outcomes } = await window.api.capturePosters(workspace, [video.relativePath], {
      precise: true
    })
    if (outcomes[0]?.error) throw new Error(outcomes[0].error)
    return { frames: outcomes[0]?.frames ?? [], scores: outcomes[0]?.scores ?? [] }
  }

  const captureCurrent = async (): Promise<void> => {
    const player = videoRef.current
    if (!player) return
    setCapturingCurrent(true)
    setError('')
    try {
      const timestampMs = Math.round(player.currentTime * 1000)
      const frame = await window.api.capturePosterAt(video.path, player.currentTime)
      onCandidates(
        [...candidates, frame],
        [
          ...scores,
          {
            path: frame,
            score: 0,
            clarity: 0,
            brightness: 0,
            contrast: 0,
            blackRatio: 0,
            uniformRatio: 0,
            rejected: false,
            timestampMs,
            manual: true
          }
        ]
      )
      onSelect(frame)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCapturingCurrent(false)
    }
  }

  const regenerate = async (): Promise<void> => {
    setGenerating(true)
    setError('')
    try {
      const { frames, scores: nextScores } = await generate()
      onCandidates(frames, nextScores)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const dirty = !!selection && selection !== video.posterPath

  const save = async (): Promise<void> => {
    if (!selection || !dirty) return
    setConfirming(false)
    setSaving(true)
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
    } finally {
      setSaving(false)
    }
  }

  const seekTo = async (timestampMs: number): Promise<void> => {
    const player = videoRef.current
    if (!player) return
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        player.removeEventListener('seeked', finish)
        player.removeEventListener('error', fail)
        resolve()
      }
      const fail = (): void => {
        player.removeEventListener('seeked', finish)
        player.removeEventListener('error', fail)
        reject(new Error('播放器定位失败'))
      }
      player.addEventListener('seeked', finish, { once: true })
      player.addEventListener('error', fail, { once: true })
      player.currentTime = timestampMs / 1000
    })
  }

  const togglePlayback = (): void => {
    const player = videoRef.current
    if (!player) return
    if (player.paused) void player.play().catch(() => {})
    else player.pause()
  }

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

  const allFrames = video.posterPath ? [video.posterPath, ...candidates] : candidates
  const scoreFor = (frame: string): CandidateFrameScore | undefined =>
    scores.find((entry) => entry.path === frame)
  const contactFrames = allFrames.map((path) => ({
    path,
    score: scoreFor(path),
    current: path === video.posterPath
  }))

  return (
    <div className="dialog-overlay" onClick={close}>
      <div
        className="detail-modal poster-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`封面详情：${video.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="detail-header">
          <div>
            <b>{video.name}</b>
            <span className="muted">
              选择候选会在播放器完成定位后标记；相似分组仅辅助浏览，不改变保存和推荐。
            </span>
          </div>
          <button className="chip-remove" aria-label="关闭封面详情" onClick={close}>
            关闭
          </button>
        </div>
        <video ref={videoRef} src={mediaUrl(video.path)} controls className="detail-player" />
        <div className="detail-actions">
          {candidates.length === 0 && (
            <button className="secondary" disabled={generating || saving} onClick={regenerate}>
              {generating ? '生成候选帧中…' : '生成候选帧'}
            </button>
          )}
          <button
            className="secondary"
            disabled={capturingCurrent || saving}
            onClick={captureCurrent}
          >
            {capturingCurrent ? '截取中…' : '截取当前帧'}
          </button>
          <button
            disabled={!dirty || saving}
            onClick={() => (video.posterPath ? setConfirming(true) : save())}
          >
            {saving ? '保存中…' : dirty ? '保存封面' : '无改动'}
          </button>
        </div>
        {error && <p className="danger-text">{error}</p>}
        {generating && allFrames.length === 0 ? <p className="muted">正在截取候选帧…</p> : null}
        <PosterContactSheet
          frames={contactFrames}
          selection={selection}
          version={version}
          onSelect={onSelect}
          onSeek={seekTo}
          onTogglePlayback={togglePlayback}
          onSave={() => (video.posterPath ? setConfirming(true) : void save())}
          onClose={close}
        />
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
