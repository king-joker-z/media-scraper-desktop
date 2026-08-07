import { useState } from 'react'
import type { HealthReport } from '../../../shared/types'
import ErrorBanner from '../components/ErrorBanner'
import { formatBytes } from '../utils/format'

/**
 * 视频完整性体检（F3）：ffmpeg 全量解码校验损坏文件，
 * 并汇总缺封面 / 缺 NFO / 体积分布。全量解码耗时，刻意手动触发，不接自动重扫。
 */
function HealthPage({
  workspace,
  onChooseWorkspace
}: {
  active: boolean
  workspace: string
  onChooseWorkspace: () => Promise<void>
}): React.JSX.Element {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')

  const scan = async (): Promise<void> => {
    if (!workspace) return
    setScanning(true)
    setError('')
    try {
      setReport(await window.api.scanHealth(workspace))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">健康体检</p>
          <h1>视频完整性体检</h1>
          <p className="muted">
            逐文件全量解码校验（发现下载残缺的损坏视频），并汇总缺封面 / 缺 NFO /
            体积分布。只读，不改动文件。
          </p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onChooseWorkspace} disabled={scanning}>
            选择工作区
          </button>
          <button className="secondary" onClick={scan} disabled={!workspace || scanning}>
            {scanning ? '体检中…' : '开始体检'}
          </button>
          {scanning && (
            <button className="secondary" onClick={() => window.api.cancelHealth()}>
              取消
            </button>
          )}
        </div>
      </header>

      <section className="path-card">
        <span>当前工作区</span>
        <strong>{workspace || '尚未选择目录'}</strong>
      </section>

      {error && <ErrorBanner message={error} />}

      {!report && !scanning && (
        <section className="empty">
          <h2>准备体检</h2>
          <p>
            全量解码校验耗时约等于视频总时长 ÷ 解码倍速，大库建议闲时进行。
            进度显示在右下角任务条，可随时取消。
          </p>
        </section>
      )}

      {report && (
        <>
          <section className="stats">
            <div>
              <span>视频总数</span>
              <b>{report.total}</b>
            </div>
            <div>
              <span>总体积</span>
              <b>{formatBytes(report.totalBytes)}</b>
            </div>
            <div>
              <span>已校验</span>
              <b>{report.checked}</b>
            </div>
            <div>
              <span>损坏文件</span>
              <b className={report.corrupted.length > 0 ? 'danger-text' : ''}>
                {report.corrupted.length}
              </b>
            </div>
            <div>
              <span>缺封面</span>
              <b>{report.missingPoster.length}</b>
            </div>
            <div>
              <span>缺 NFO</span>
              <b>{report.missingNfo.length}</b>
            </div>
          </section>

          {report.cancelled && (
            <section className="warning">
              <p>⚠️ 体检已取消，结果仅覆盖已校验的 {report.checked} 个文件。</p>
            </section>
          )}

          {report.corrupted.length > 0 && (
            <section className="settings-card">
              <h2 className="danger-text">损坏文件（{report.corrupted.length}）</h2>
              <p className="muted">
                这些文件解码报错，通常是下载不完整或存储损坏，建议重新获取源文件。
              </p>
              {report.corrupted.map((item) => (
                <div key={item.relativePath} className="health-corrupt-row">
                  <b title={item.relativePath}>{item.relativePath}</b>
                  <ErrorBanner message={item.error} />
                </div>
              ))}
            </section>
          )}

          {report.corrupted.length === 0 && !report.cancelled && (
            <section className="notice-banner">全部 {report.checked} 个视频解码通过 🎉</section>
          )}

          <section className="settings-card">
            <h2>整理度</h2>
            <details>
              <summary className="muted">
                缺封面（{report.missingPoster.length}）— 可在「封面管理」批量生成
              </summary>
              <div className="health-list">
                {report.missingPoster.map((rel) => (
                  <p key={rel}>{rel}</p>
                ))}
              </div>
            </details>
            <details>
              <summary className="muted">
                缺 NFO（{report.missingNfo.length}）— 可在「NFO 归档」生成
              </summary>
              <div className="health-list">
                {report.missingNfo.map((rel) => (
                  <p key={rel}>{rel}</p>
                ))}
              </div>
            </details>
          </section>

          {report.largest.length > 0 && (
            <section className="settings-card">
              <h2>体积最大的视频（前 {report.largest.length}）</h2>
              {report.largest.map((item) => (
                <div key={item.relativePath} className="dup-row health-largest-row">
                  <span className="dup-path" title={item.relativePath}>
                    {item.relativePath}
                  </span>
                  <span className="muted">{formatBytes(item.size)}</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  )
}

export default HealthPage
