import { useEffect, useMemo, useRef, useState } from 'react'
import type { DedupeScanResult, DupItem, MediaInfo, SimilarDupItem } from '../../../shared/types'
import ConfirmDialog from '../components/ConfirmDialog'
import ErrorBanner from '../components/ErrorBanner'
import VideoModal from '../components/VideoModal'
import { formatBytes, formatDuration, joinPath } from '../utils/format'

/** 质量徽标：分辨率 · 时长 · 平均码率 */
const mediaBadge = (media: MediaInfo | null, size: number): string => {
  if (!media) return '未知参数'
  const parts = [`${media.width}×${media.height}`]
  if (media.durationMs > 0) {
    parts.push(formatDuration(media.durationMs))
    const mbps = (size * 8) / (media.durationMs / 1000) / 1e6
    if (mbps > 0.05) parts.push(`${mbps.toFixed(1)} Mbps`)
  }
  return parts.join(' · ')
}

function DedupePage({
  active,
  workspace,
  onChooseWorkspace
}: {
  active: boolean
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [result, setResult] = useState<DedupeScanResult | null>(null)
  const [resultWorkspace, setResultWorkspace] = useState('')
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  // 对比预览（F5）：试看的视频相对路径
  const [previewRel, setPreviewRel] = useState<string | null>(null)
  // 快速模式：仅完全重复（跳过全量 ffprobe 与相似聚类，大工作区首扫从分钟级降到秒级）
  const [fastMode, setFastMode] = useState(false)
  const workspaceRef = useRef(workspace)

  useEffect(() => {
    workspaceRef.current = workspace
  }, [workspace])

  // 常驻页面保留旧状态，但只有与当前工作区匹配的扫描结果、勾选与预览才允许显示或执行。
  const currentResult = resultWorkspace === workspace ? result : null

  // 注意：去重扫描要逐文件算哈希 + 探测，成本高，刻意不接自动重扫，由用户手动触发
  const scan = async (): Promise<void> => {
    const scanWorkspace = workspace
    if (!scanWorkspace) return
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const next = await window.api.scanDuplicates(scanWorkspace, !fastMode)
      if (workspaceRef.current !== scanWorkspace) return
      setResult(next)
      setResultWorkspace(scanWorkspace)
      // 默认勾选：完全重复组中除「建议保留」（质量最高）外的所有副本
      setChecked(
        new Set(
          next.exact.flatMap((group) =>
            group.items
              .filter((item) => item.relativePath !== group.keepRel)
              .map((i) => i.relativePath)
          )
        )
      )
    } catch (err) {
      if (workspaceRef.current === scanWorkspace)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (workspaceRef.current === scanWorkspace) setLoading(false)
    }
  }

  const checkedBytes = useMemo(() => {
    if (!currentResult) return 0
    const all = [
      ...currentResult.exact.flatMap((g) => g.items),
      ...currentResult.similar.flatMap((g) => g.items)
    ]
    return all
      .filter((item) => checked.has(item.relativePath))
      .reduce((sum, item) => sum + item.size, 0)
  }, [currentResult, checked])

  const toggle = (rel: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }

  const execute = async (): Promise<void> => {
    const deleteWorkspace = workspace
    if (!deleteWorkspace || !currentResult) return
    const deletePaths = [...checked]
    setConfirming(false)
    setDeleting(true)
    setError('')
    try {
      const report = await window.api.deleteDuplicates(deleteWorkspace, deletePaths)
      if (workspaceRef.current !== deleteWorkspace) return
      setNotice(
        `已删除 ${report.deletedCount} 个重复文件（释放 ${formatBytes(checkedBytes)}）` +
          (report.failed.length ? `，失败 ${report.failed.length} 个` : '')
      )
      await scan()
    } catch (err) {
      if (workspaceRef.current === deleteWorkspace)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (workspaceRef.current === deleteWorkspace) setDeleting(false)
    }
  }

  const renderItem = (
    item: DupItem | SimilarDupItem,
    keepRel: string,
    showCopies: boolean
  ): React.JSX.Element => {
    const isKeep = item.relativePath === keepRel
    const copies = 'exactCopies' in item ? item.exactCopies : 0
    return (
      <label key={item.relativePath} className="confirm-check dup-row">
        <input
          className="check-input"
          type="checkbox"
          checked={checked.has(item.relativePath)}
          onChange={() => toggle(item.relativePath)}
        />
        <span className="dup-path" title={item.relativePath}>
          {item.relativePath}
        </span>
        <span className="muted dup-media">{mediaBadge(item.media, item.size)}</span>
        {showCopies && copies > 1 && <span className="dup-badge">完全相同 ×{copies}</span>}
        <span className={isKeep ? 'ok-text' : 'muted'}>{isKeep ? '建议保留' : '重复'}</span>
        <button
          className="chip-remove"
          title="试看对比"
          onClick={(event) => {
            event.preventDefault()
            setPreviewRel(item.relativePath)
          }}
        >
          ▶ 试看
        </button>
      </label>
    )
  }

  return (
    <div className="page">
      <header className="page-header" aria-hidden={!active}>
        <div>
          <p className="eyebrow">视频去重</p>
          <h1>重复视频检测</h1>
          <p className="muted">
            「完全重复」按大小 +
            头/中/尾内容指纹判定；「相似重复」找同片不同压制版本（同分辨率、时长相近）。
          </p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onChooseWorkspace} disabled={deleting}>
            选择工作区
          </button>
          <label
            className="confirm-check"
            title="仅检测完全重复，跳过相似重复聚类（大目录显著提速）"
          >
            <input
              className="check-input"
              type="checkbox"
              checked={fastMode}
              onChange={(event) => setFastMode(event.target.checked)}
              disabled={loading || deleting}
            />
            <span className="muted">快速模式</span>
          </label>
          <button className="secondary" onClick={scan} disabled={!workspace || loading || deleting}>
            {loading ? '检测中…' : '开始检测'}
          </button>
          {deleting ? (
            <button className="secondary" onClick={() => void window.api.cancelDedupeDelete()}>
              取消删除
            </button>
          ) : currentResult && checked.size > 0 ? (
            <button className="danger-button" onClick={() => setConfirming(true)}>
              {`删除选中（${checked.size}）`}
            </button>
          ) : null}
        </div>
      </header>

      <section className="path-card">
        <span>当前工作区</span>
        <strong>{workspace || '尚未选择目录'}</strong>
      </section>

      {error && <ErrorBanner message={error} />}
      {notice && (
        <section className="notice-banner">
          {notice}
          <button className="error-copy" title="关闭" onClick={() => setNotice('')}>
            ✕
          </button>
        </section>
      )}

      {currentResult && currentResult.exact.length === 0 && currentResult.similar.length === 0 && (
        <section className="empty">
          <h2>没有发现重复视频 🎉</h2>
          <p>当前工作区内没有内容相同或相似的视频文件。</p>
        </section>
      )}
      {!currentResult && (
        <section className="empty">
          <h2>准备检测</h2>
          <p>
            选择工作区并点击「开始检测」。扫描需逐文件计算内容指纹并读取媒体参数，
            大目录耗时较长，因此不会自动触发。只读扫描，不改动任何文件。
          </p>
        </section>
      )}

      {currentResult && currentResult.exact.length > 0 && (
        <section className="settings-card">
          <h2>完全重复（{currentResult.exact.length} 组）</h2>
          <p className="muted">内容指纹完全相同，默认勾选除「建议保留」（质量最高）外的副本。</p>
          {currentResult.exact.map((group, index) => (
            <div key={group.hash} className="dup-group">
              <h3>
                重复组 {index + 1}
                <small className="muted">
                  {' '}
                  · {group.items.length} 个文件 · 每个 {formatBytes(group.sizeBytes)}
                </small>
              </h3>
              {group.items.map((item) => renderItem(item, group.keepRel, false))}
            </div>
          ))}
        </section>
      )}

      {currentResult && currentResult.similar.length > 0 && (
        <section className="settings-card">
          <h2>相似重复（{currentResult.similar.length} 组）</h2>
          <p className="muted">
            同一影片的不同压制版本（同分辨率、时长相近但内容指纹不同）。默认不勾选，请人工确认后选择删除。
          </p>
          {currentResult.similar.map((group) => (
            <div key={group.key + group.keepRel} className="dup-group">
              <h3>
                {group.key}
                <small className="muted"> · {group.items.length} 个版本 · 建议保留体积最大者</small>
              </h3>
              {group.items.map((item) => renderItem(item, group.keepRel, true))}
            </div>
          ))}
        </section>
      )}

      {confirming && (
        <ConfirmDialog
          title="删除重复视频"
          deleteCount={checked.size}
          deleteBytes={checkedBytes}
          danger={checked.size > 50}
          recoverable
          extra="删除选中的重复文件（默认进系统回收站，可在设置改永久删除），每组未被勾选的文件保留。"
          onConfirm={execute}
          onCancel={() => setConfirming(false)}
        />
      )}

      {currentResult && previewRel && workspace && (
        <VideoModal
          path={joinPath(workspace, previewRel)}
          title={previewRel}
          onClose={() => setPreviewRel(null)}
        />
      )}
    </div>
  )
}

export default DedupePage
