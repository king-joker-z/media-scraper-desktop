import { useMemo, useState } from 'react'
import type { PosterVideoItem } from '../../../shared/types'
import ConfirmDialog from '../components/ConfirmDialog'
import PosterDetail from '../components/PosterDetail'
import { formatBytes } from '../utils/format'
import { mediaUrl } from '../utils/media'
import { useWorkspaceSync } from '../utils/useWorkspaceSync'

type Selections = Record<string, string>
type CandidatesMap = Record<string, string[]>

function PosterPage({
  active,
  workspace,
  onChooseWorkspace
}: {
  active: boolean
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [videos, setVideos] = useState<PosterVideoItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmingBatch, setConfirmingBatch] = useState(false)
  const [detail, setDetail] = useState<PosterVideoItem | null>(null)
  const [candidatesMap, setCandidatesMap] = useState<CandidatesMap>({})
  const [selections, setSelections] = useState<Selections>({})
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  // 封面保存后递增，给图片 URL 加版本号破除 Chromium 图片缓存
  const [coverEpoch, setCoverEpoch] = useState(0)

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

  // 页面可见时对比工作区指纹：有变化自动重扫
  useWorkspaceSync(workspace, active, refresh)

  /** 卡片实际展示的封面：显式选择 > 现存 poster > 首个候选帧 */
  const effectiveCover = (video: PosterVideoItem): string | null =>
    selections[video.relativePath] ??
    video.posterPath ??
    candidatesMap[video.relativePath]?.[0] ??
    null

  /** 待确认 = 显式选择了与现存 poster 不同的帧 */
  const pending = useMemo(
    () =>
      videos.filter((video) => {
        const selected = selections[video.relativePath]
        return selected && selected !== video.posterPath
      }),
    [videos, selections]
  )
  const replaceCount = pending.filter((video) => video.posterPath).length
  const withoutCandidates = useMemo(
    () => videos.filter((video) => !candidatesMap[video.relativePath]),
    [videos, candidatesMap]
  )

  /** 为全部尚未生成候选的视频截帧（含已有封面的，原封面仍是默认选中） */
  const captureAll = async (): Promise<void> => {
    if (!workspace || withoutCandidates.length === 0) return
    setCapturing(true)
    setError('')
    setNotice('')
    try {
      const { outcomes } = await window.api.capturePosters(
        workspace,
        withoutCandidates.map((v) => v.relativePath)
      )
      const nextCandidates: CandidatesMap = {}
      const nextSelections: Selections = {}
      const failed: string[] = []
      for (const outcome of outcomes) {
        if (outcome.error || outcome.frames.length === 0) {
          failed.push(outcome.relativePath)
          continue
        }
        nextCandidates[outcome.relativePath] = outcome.frames
        // 无封面视频默认选中第一张候选 → 卡片立即渲染首帧
        const video = videos.find((v) => v.relativePath === outcome.relativePath)
        if (video && !video.posterPath && !selections[video.relativePath]) {
          nextSelections[outcome.relativePath] = outcome.frames[0]
        }
      }
      setCandidatesMap((prev) => ({ ...prev, ...nextCandidates }))
      setSelections((prev) => ({ ...prev, ...nextSelections }))
      const ok = Object.keys(nextCandidates).length
      setNotice(
        failed.length
          ? `已生成 ${ok} 个视频的候选帧，${failed.length} 个失败`
          : `已生成 ${ok} 个视频的候选帧，默认选中第一张，可直接一键确认`
      )
      if (failed.length) setError(`截帧失败示例：${failed[0]}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCapturing(false)
    }
  }

  /** 一键确认：批量保存所有"待确认"封面 */
  const saveBatch = async (): Promise<void> => {
    setConfirmingBatch(false)
    setSaving(true)
    setError('')
    try {
      const report = await window.api.savePostersBatch(videos, selections)
      const savedRel = new Set(report.outcomes.filter((o) => o.saved).map((o) => o.relativePath))
      setVideos((prev) =>
        prev.map((video) => {
          const outcome = report.outcomes.find((o) => o.relativePath === video.relativePath)
          return outcome?.saved ? { ...video, posterPath: outcome.saved } : video
        })
      )
      setCandidatesMap((prev) => {
        const next = { ...prev }
        for (const rel of savedRel) delete next[rel]
        return next
      })
      setSelections((prev) => {
        const next = { ...prev }
        for (const rel of savedRel) delete next[rel]
        return next
      })
      setCoverEpoch((epoch) => epoch + 1)
      setNotice(
        `批量保存完成：成功 ${report.savedCount} 个` +
          (report.failedCount ? `，失败 ${report.failedCount} 个` : '') +
          (report.cancelled ? '（已取消）' : '')
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">模块四 · 封面管理</p>
          <h1>Poster 封面</h1>
          <p className="muted">
            为全部视频生成候选帧并默认选中第一张；不满意的进详情换帧，最后一键批量确认。
          </p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onChooseWorkspace} disabled={capturing || saving}>
            选择工作区
          </button>
          <button
            className="secondary"
            onClick={refresh}
            disabled={!workspace || loading || capturing || saving}
          >
            {loading ? '扫描中…' : '刷新列表'}
          </button>
          <button
            className="secondary"
            disabled={!workspace || capturing || saving || withoutCandidates.length === 0}
            onClick={captureAll}
          >
            {capturing ? '截帧中…' : `生成候选帧（${withoutCandidates.length}）`}
          </button>
          <button
            disabled={pending.length === 0 || saving || capturing}
            onClick={() => setConfirmingBatch(true)}
          >
            {saving ? '保存中…' : `一键确认封面（${pending.length} 待确认）`}
          </button>
          {(capturing || saving) && (
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
      {notice && <section className="notice-banner">{notice}</section>}

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
          {videos.map((video) => {
            const cover = effectiveCover(video)
            const isPending =
              !!selections[video.relativePath] &&
              selections[video.relativePath] !== video.posterPath
            return (
              <button
                key={video.relativePath}
                className="video-card"
                onClick={() => setDetail(video)}
              >
                <span className="video-thumb">
                  {cover ? (
                    <img
                      src={`${mediaUrl(cover)}?v=${coverEpoch}`}
                      alt={video.name}
                      loading="lazy"
                    />
                  ) : (
                    <span className="video-thumb-empty">🎬</span>
                  )}
                </span>
                <span className="video-meta">
                  <b>{video.name}</b>
                  <span className={isPending ? 'pending-text' : 'muted'}>
                    {formatBytes(video.size)} ·{' '}
                    {isPending ? '待确认' : video.posterPath ? '已有封面' : '无封面'}
                  </span>
                </span>
              </button>
            )
          })}
        </section>
      )}

      {detail && (
        <PosterDetail
          key={detail.relativePath}
          video={detail}
          workspace={workspace}
          candidates={candidatesMap[detail.relativePath] ?? []}
          selection={selections[detail.relativePath] ?? detail.posterPath}
          version={coverEpoch}
          onSelect={(frame) => setSelections((prev) => ({ ...prev, [detail.relativePath]: frame }))}
          onCandidates={(frames) =>
            setCandidatesMap((prev) => ({ ...prev, [detail.relativePath]: frames }))
          }
          onSaved={(savedPath) => {
            const rel = detail.relativePath
            setCoverEpoch((epoch) => epoch + 1)
            setVideos((prev) =>
              prev.map((v) => (v.relativePath === rel ? { ...v, posterPath: savedPath } : v))
            )
            setCandidatesMap((prev) => {
              const next = { ...prev }
              delete next[rel]
              return next
            })
            setSelections((prev) => {
              const next = { ...prev }
              delete next[rel]
              return next
            })
            setDetail(null)
            setNotice(`已保存封面：${detail.name}`)
          }}
          onClose={() => setDetail(null)}
        />
      )}

      {confirmingBatch && (
        <ConfirmDialog
          title="一键确认封面"
          deleteCount={replaceCount}
          deleteBytes={0}
          danger={replaceCount > 50}
          extra={`将为 ${pending.length} 个视频保存所选封面（${replaceCount} 个会替换并永久删除旧封面），未选中的候选图将被清理。封面统一保存为「视频名-poster.jpg」。`}
          onConfirm={saveBatch}
          onCancel={() => setConfirmingBatch(false)}
        />
      )}
    </div>
  )
}

export default PosterPage
