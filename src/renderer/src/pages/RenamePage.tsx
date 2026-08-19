import { useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  PosterVideoItem,
  ProbeContainerItem,
  RenamePairInput,
  RenameReport
} from '../../../shared/types'
import {
  applyRegexRules,
  buildSequenceStems,
  extOfName,
  sortVideos,
  stemOfName,
  stripSeqPrefix,
  validateStems,
  withSequencePrefix
} from '../../../shared/rename-rules.mjs'
import ConfirmDialog from '../components/ConfirmDialog'
import ErrorBanner from '../components/ErrorBanner'
import { useWorkspaceSync } from '../utils/useWorkspaceSync'

type Mode = 'seq' | 'regex' | 'ai' | 'ext'

const parentFolderOf = (relativePath: string): string => {
  const segments = relativePath.split(/[\\/]/)
  return segments.length > 1 ? (segments.at(-2) ?? '') : '（根目录）'
}

const MODE_TABS: { key: Mode; label: string }[] = [
  { key: 'seq', label: '纯序号' },
  { key: 'regex', label: '正则清洗 + 序号' },
  { key: 'ai', label: 'AI 重命名' },
  { key: 'ext', label: '仅改扩展名 .mp4' }
]

interface SeqOptions {
  sortBy: 'title' | 'size'
  order: 'asc' | 'desc'
  digits: number
  separator: string
  start: number
}

function RenamePage({
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
  const [mode, setMode] = useState<Mode>('seq')
  const [seq, setSeq] = useState<SeqOptions>({
    sortBy: 'title',
    order: 'asc',
    digits: 2,
    separator: '.',
    start: 1
  })
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [activeRules, setActiveRules] = useState<number[]>([0])
  const [customRule, setCustomRule] = useState({ pattern: '', replacement: '', flags: 'g' })
  const [useCustom, setUseCustom] = useState(false)
  const [aiNamesMap, setAiNamesMap] = useState<Record<string, string> | null>(null)
  const [selectedAiVideos, setSelectedAiVideos] = useState<Set<string>>(() => new Set())
  const [aiLoading, setAiLoading] = useState(false)
  const [regenerating, setRegenerating] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, ProbeContainerItem>>({})
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [executing, setExecuting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [report, setReport] = useState<RenameReport | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    window.api
      .getSettings()
      .then((next) => {
        if (!disposed) setSettings(next)
      })
      .catch(() => {})
    // 重命名页为常驻挂载；订阅设置广播，避免切换当前 AI 平台后仍展示首次加载的旧配置。
    const unsubscribe = window.api.onSettingsChange(setSettings)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])
  const templates = useMemo(() => settings?.regexTemplates ?? [], [settings])
  const activeAi = useMemo(
    () =>
      settings?.aiProviders.find((p) => p.id === settings.activeProviderId) ??
      settings?.aiProviders[0],
    [settings]
  )

  const refresh = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    setError('')
    setReport(null)
    setAiNamesMap(null)
    setSelectedAiVideos(new Set())
    setEdits({})
    setProbes({})
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

  // relativePath → 视频索引：computedPairs/changedPairs/行渲染都是 O(1) 查表，
  // 替代原先每对 pair 一次 videos.find（渲染期 O(n²)）
  const videoByRel = useMemo(
    () => new Map(videos.map((video) => [video.relativePath, video])),
    [videos]
  )

  /** 各模式生成目标词干 */
  const computedPairs = useMemo((): RenamePairInput[] => {
    const withPoster = (
      video: PosterVideoItem,
      newStem: string,
      newExt?: string
    ): RenamePairInput => ({
      videoRel: video.relativePath,
      posterRel: video.posterRelativePath,
      newStem,
      newExt
    })
    if (mode === 'ext') {
      return videos
        .filter((v) => extOfName(v.name).toLowerCase() !== '.mp4')
        .map((v) => withPoster(v, stemOfName(v.name), '.mp4'))
    }
    if (mode === 'ai') {
      if (!aiNamesMap) return []
      // AI 命名后叠加序号前缀，排序/位数/分隔符与纯序号一致
      const sorted = sortVideos(videos, seq.sortBy, seq.order)
      return withSequencePrefix(
        sorted.map((v) => ({
          videoRel: v.relativePath,
          // 剥离旧序号前缀（含 AI 返回中可能带的前缀）
          stem: stripSeqPrefix(aiNamesMap[v.relativePath] ?? stemOfName(v.name))
        })),
        seq
      ).map((p) => {
        const video = videoByRel.get(p.videoRel)
        return withPoster(video!, p.newStem)
      })
    }
    if (mode === 'regex') {
      const rules = [
        ...activeRules.map((i) => templates[i]).filter(Boolean),
        ...(useCustom && customRule.pattern ? [customRule] : [])
      ]
      const cleaned = videos.map((v) => ({
        ...v,
        name: `${applyRegexRules(stemOfName(v.name), rules)}${extOfName(v.name)}`
      }))
      return buildSequenceStems(cleaned, seq).map((p) => {
        const video = videoByRel.get(p.videoRel)
        return withPoster(video!, p.newStem)
      })
    }
    // seq 模式
    return buildSequenceStems(videos, seq).map((p) => {
      const video = videoByRel.get(p.videoRel)
      return withPoster(video!, p.newStem)
    })
  }, [videos, videoByRel, mode, seq, templates, activeRules, customRule, useCustom, aiNamesMap])

  /** 用户手动编辑覆盖 */
  const pairs = useMemo(
    () =>
      computedPairs.map((pair) => ({
        ...pair,
        newStem: edits[pair.videoRel] ?? pair.newStem
      })),
    [computedPairs, edits]
  )
  const errors = useMemo(() => validateStems(pairs.filter((p) => !p.newExt)), [pairs])
  const changedPairs = useMemo(
    () =>
      pairs.filter((pair) => {
        const video = videoByRel.get(pair.videoRel)
        if (!video) return false
        const finalName = `${pair.newStem}${pair.newExt ?? extOfName(video.name)}`
        return finalName !== video.name
      }),
    [pairs, videoByRel]
  )
  // memo 化：大目录下每次击键都重渲染，避免每次都全量 filter
  const riskyExtCount = useMemo(
    () => pairs.filter((p) => p.newExt && probes[p.videoRel] && !probes[p.videoRel].isMp4).length,
    [pairs, probes]
  )

  const runAi = async (forceRefresh = false): Promise<void> => {
    setAiLoading(true)
    setError('')
    try {
      const sorted = sortVideos(videos, 'title', 'asc')
      const names = await window.api.requestAiNames(
        sorted.map((v) => ({
          parentFolder: parentFolderOf(v.relativePath),
          // 发送给 AI 的文件名先剥离旧序号前缀，避免模型沿用；扩展名不影响命名，不发送。
          fileName: stripSeqPrefix(stemOfName(v.name))
        })),
        // 常规生成优先复用已有结果；只有“全部重新生成”才绕过缓存。
        forceRefresh
      )
      setAiNamesMap(
        Object.fromEntries(
          sorted.map((v, index) => [v.relativePath, names[index] ?? stemOfName(v.name)])
        )
      )
      setSelectedAiVideos(new Set())
    } catch (err) {
      // 主进程已按 HTTP 状态返回对应处理建议；503 等服务端故障不应误导为本地 Token/模型配置问题。
      setError(`AI 命名失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setAiLoading(false)
    }
  }

  /** 重新生成勾选的视频（仅 AI 模式）：单次请求，其他预览结果保持不变 */
  const regenerateSelected = async (): Promise<void> => {
    const selectedVideos = videos.filter((video) => selectedAiVideos.has(video.relativePath))
    if (selectedVideos.length === 0) return

    setAiLoading(true)
    setError('')
    try {
      const names = await window.api.requestAiNames(
        selectedVideos.map((video) => ({
          parentFolder: parentFolderOf(video.relativePath),
          fileName: stripSeqPrefix(stemOfName(video.name))
        })),
        true
      )
      if (names.length !== selectedVideos.length || names.some((name) => !name)) {
        throw new Error('AI 返回的名称数量不完整')
      }
      setAiNamesMap((prev) => ({
        ...prev,
        ...Object.fromEntries(
          selectedVideos.map((video, index) => [
            video.relativePath,
            names[index] ?? stemOfName(video.name)
          ])
        )
      }))
      setSelectedAiVideos(new Set())
    } catch (err) {
      setError(`AI 命名失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setAiLoading(false)
    }
  }

  /** 单条重新生成（仅 AI 模式）：只重发这一条，不影响其他结果 */
  const regenerateOne = async (video: PosterVideoItem): Promise<void> => {
    setRegenerating(video.relativePath)
    setError('')
    try {
      const names = await window.api.requestAiNames(
        [
          {
            parentFolder: parentFolderOf(video.relativePath),
            fileName: stripSeqPrefix(stemOfName(video.name))
          }
        ],
        true
      )
      if (names.length === 0 || !names[0]) throw new Error('AI 返回空结果')
      setAiNamesMap((prev) => ({ ...prev, [video.relativePath]: names[0] }))
      setSelectedAiVideos((prev) => {
        const next = new Set(prev)
        next.delete(video.relativePath)
        return next
      })
    } catch (err) {
      setError(`AI 命名失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRegenerating(null)
    }
  }

  const runProbe = async (): Promise<void> => {
    if (!workspace || pairs.length === 0) return
    setLoading(true)
    try {
      const result = await window.api.probeContainers(
        workspace,
        pairs.map((p) => p.videoRel)
      )
      setProbes(Object.fromEntries(result.map((item) => [item.relativePath, item])))
    } finally {
      setLoading(false)
    }
  }

  const execute = async (): Promise<void> => {
    if (!workspace) return
    setConfirming(false)
    setExecuting(true)
    setError('')
    try {
      const result = await window.api.executeRename(workspace, changedPairs)
      setReport(result)
      if (!result.cancelled) await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExecuting(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">模块三 · 批量重命名</p>
          <h1>批量重命名</h1>
          <p className="muted">视频与 poster 成组改名，poster 自动同步为「新名-poster.jpg」。</p>
        </div>
        <div className="actions">
          <button
            className="secondary"
            onClick={onChooseWorkspace}
            disabled={executing || aiLoading}
          >
            选择工作区
          </button>
          <button
            className="secondary"
            onClick={refresh}
            disabled={!workspace || loading || executing || aiLoading}
          >
            {loading ? '扫描中…' : '扫描视频'}
          </button>
          {pairs.length > 0 && (
            <button
              disabled={
                changedPairs.length === 0 ||
                Object.keys(errors).length > 0 ||
                executing ||
                aiLoading
              }
              onClick={() => setConfirming(true)}
            >
              {executing ? '执行中…' : `执行重命名（${changedPairs.length}）`}
            </button>
          )}
          {(executing || aiLoading) && (
            <button className="secondary" onClick={() => void window.api.cancelRename()}>
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

      {loaded && videos.length > 0 && (
        <>
          <div className="mode-tabs">
            {MODE_TABS.map((tab) => (
              <button
                key={tab.key}
                className={`mode-tab ${mode === tab.key ? 'active' : ''}`}
                onClick={() => setMode(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {(mode === 'seq' || mode === 'regex') && (
            <section className="settings-card">
              <SeqControls seq={seq} onChange={setSeq} />
              {mode === 'regex' && (
                <>
                  <h2>正则规则（按顺序应用）</h2>
                  {templates.map((template, index) => (
                    <label key={template.name} className="confirm-check">
                      <input
                        className="check-input"
                        type="checkbox"
                        checked={activeRules.includes(index)}
                        onChange={(event) =>
                          setActiveRules((prev) =>
                            event.target.checked
                              ? [...prev, index]
                              : prev.filter((i) => i !== index)
                          )
                        }
                      />
                      {template.name}
                      <code className="muted">
                        /{template.pattern}/{template.flags} → {template.replacement || '∅'}
                      </code>
                    </label>
                  ))}
                  <label className="confirm-check">
                    <input
                      className="check-input"
                      type="checkbox"
                      checked={useCustom}
                      onChange={(event) => setUseCustom(event.target.checked)}
                    />
                    自定义规则
                  </label>
                  {useCustom && (
                    <div className="model-add">
                      <input
                        placeholder="正则，如 @[^\\s@]+$"
                        value={customRule.pattern}
                        onChange={(event) =>
                          setCustomRule((prev) => ({ ...prev, pattern: event.target.value }))
                        }
                      />
                      <input
                        placeholder="替换为（可空）"
                        value={customRule.replacement}
                        onChange={(event) =>
                          setCustomRule((prev) => ({ ...prev, replacement: event.target.value }))
                        }
                      />
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {mode === 'ai' && (
            <section className="settings-card">
              <h2>AI 命名</h2>
              <p className="muted">
                当前平台：<b>{activeAi?.name ?? '未配置'}</b> · 模型：
                <b>{activeAi?.selectedModel || '未选择'}</b>
                {activeAi && !activeAi.token && (
                  <span className="danger-text">（未配置 Token，请到设置页填写）</span>
                )}
                。仅发送文件名与父目录名，不上传视频；平台/模型/prompt 均可在设置页调整。
              </p>
              <p className="muted">
                首次生成会复用本会话内相同输入的成功结果；每批
                {activeAi?.modelTunings[activeAi.selectedModel]?.batchSize ?? 40} 个、最多
                {activeAi?.modelTunings[activeAi.selectedModel]?.concurrency ?? 3}
                并发请求，单请求超时
                {activeAi?.modelTunings[activeAi.selectedModel]?.requestTimeoutSeconds ?? 300} 秒，
                每个名称独立生成互不影响。普通“重新生成”优先复用已有结果；勾选表格中的多个视频可仅重新生成选中项，“全部重新生成”和单条“重新生成”则会再次请求模型。
                返回后自动叠加序号前缀：
              </p>
              <SeqControls seq={seq} onChange={setSeq} />
              <div className="actions">
                <button
                  onClick={() => void runAi()}
                  disabled={aiLoading || executing || videos.length === 0}
                >
                  {aiLoading ? 'AI 生成中…' : aiNamesMap ? '重新生成' : '生成 AI 命名'}
                </button>
                {aiNamesMap && selectedAiVideos.size > 0 && (
                  <button
                    className="secondary"
                    title="仅为已勾选的视频重新请求 AI，其他预览名称保持不变"
                    onClick={() => void regenerateSelected()}
                    disabled={aiLoading || executing}
                  >
                    重新生成选中项（{selectedAiVideos.size}）
                  </button>
                )}
                {aiNamesMap && (
                  <button
                    className="secondary"
                    title="忽略本会话缓存，为全部文件重新请求 AI"
                    onClick={() => void runAi(true)}
                    disabled={aiLoading || executing || videos.length === 0}
                  >
                    全部重新生成
                  </button>
                )}
              </div>
            </section>
          )}

          {mode === 'ext' && (
            <section className="settings-card">
              <h2>仅改扩展名为 .mp4（不转码、不重封装）</h2>
              <p className="muted">
                只修改文件后缀。真实容器非 MP4 的文件可能被部分播放器拒绝，请先探测。
              </p>
              {pairs.length === 0 ? (
                <p className="notice-inline">✅ 所有视频均已是 .mp4 扩展名，无需处理。</p>
              ) : (
                <div className="actions">
                  <button className="secondary" onClick={runProbe} disabled={loading}>
                    {loading ? '探测中…' : `探测真实容器（${pairs.length}）`}
                  </button>
                  {riskyExtCount > 0 && (
                    <span className="danger-text">⚠️ {riskyExtCount} 个文件真实容器不是 MP4</span>
                  )}
                </div>
              )}
            </section>
          )}

          {pairs.length > 0 && (
            <section className="rename-table">
              <div
                className={`rename-row rename-head ${mode === 'ai' && aiNamesMap ? 'rename-ai-mode' : ''}`}
              >
                {mode === 'ai' && aiNamesMap && (
                  <span className="rename-select">
                    <input
                      type="checkbox"
                      aria-label="选择全部视频"
                      title={
                        selectedAiVideos.size === videos.length
                          ? '取消选择全部视频'
                          : '选择全部视频'
                      }
                      checked={selectedAiVideos.size === videos.length}
                      onChange={(event) =>
                        setSelectedAiVideos(
                          event.target.checked
                            ? new Set(videos.map((video) => video.relativePath))
                            : new Set()
                        )
                      }
                    />
                  </span>
                )}
                <span>原文件名</span>
                <span>新文件名（可编辑）</span>
                <span>状态</span>
              </div>
              {pairs.map((pair) => {
                const video = videoByRel.get(pair.videoRel)
                const probe = probes[pair.videoRel]
                const rowError = errors[pair.videoRel]
                return (
                  <div
                    key={pair.videoRel}
                    className={`rename-row ${mode === 'ai' && aiNamesMap ? 'rename-ai-mode' : ''} ${rowError ? 'invalid' : ''}`}
                  >
                    {mode === 'ai' && aiNamesMap && video && (
                      <span className="rename-select">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${video.name}`}
                          checked={selectedAiVideos.has(video.relativePath)}
                          onChange={(event) =>
                            setSelectedAiVideos((prev) => {
                              const next = new Set(prev)
                              if (event.target.checked) next.add(video.relativePath)
                              else next.delete(video.relativePath)
                              return next
                            })
                          }
                        />
                      </span>
                    )}
                    <span className="rename-old" title={pair.videoRel}>
                      {video?.name}
                      {pair.posterRel && <small>+ poster 同步</small>}
                    </span>
                    <span className="rename-new">
                      <input
                        value={pair.newStem}
                        disabled={!!pair.newExt}
                        onChange={(event) =>
                          setEdits((prev) => ({ ...prev, [pair.videoRel]: event.target.value }))
                        }
                      />
                      <small>{pair.newExt ?? extOfName(video?.name ?? '')}</small>
                    </span>
                    <span className="rename-status">
                      {rowError ? (
                        <b className="danger-text">{rowError}</b>
                      ) : pair.newExt && probe ? (
                        probe.isMp4 ? (
                          <b className="ok-text">容器 {probe.container}</b>
                        ) : (
                          <b className="danger-text">非 MP4 容器</b>
                        )
                      ) : (
                        <span className="muted">就绪</span>
                      )}
                      {mode === 'ai' && aiNamesMap && video && (
                        <button
                          className="rename-regenerate"
                          title="只重新生成这一条"
                          disabled={aiLoading || executing || regenerating === video.relativePath}
                          onClick={() => void regenerateOne(video)}
                        >
                          {regenerating === video.relativePath ? '生成中…' : '重新生成'}
                        </button>
                      )}
                    </span>
                  </div>
                )
              })}
            </section>
          )}
        </>
      )}

      {loaded && videos.length === 0 && (
        <section className="empty">
          <h2>没有发现视频</h2>
        </section>
      )}
      {!loaded && (
        <section className="empty">
          <h2>扫描后开始</h2>
          <p>选择工作区并点击「扫描视频」。</p>
        </section>
      )}

      {report && (
        <section className={`report-card ${report.cancelled ? 'cancelled' : ''}`}>
          <h2>{report.cancelled ? '已取消（以下为已完成部分）' : '重命名报告'}</h2>
          <div className="report-grid">
            <div>
              <span>成功改名</span>
              <b>{report.renamedCount}</b>
            </div>
            <div>
              <span>失败</span>
              <b className={report.failed.length ? 'danger-text' : ''}>{report.failed.length}</b>
            </div>
            <div>
              <span>耗时</span>
              <b>{(report.durationMs / 1000).toFixed(1)}s</b>
            </div>
          </div>
          {report.failed.length > 0 && (
            <div className="report-failed">
              {report.failed.slice(0, 20).map((item) => (
                <p key={item.target}>
                  {item.target}：{item.error}
                </p>
              ))}
              {report.failed.length > 20 && (
                <p className="muted">仅显示前 20 条，共 {report.failed.length} 条失败记录</p>
              )}
            </div>
          )}
        </section>
      )}

      {confirming && (
        <ConfirmDialog
          title="确认执行重命名"
          deleteCount={0}
          deleteBytes={0}
          danger={mode === 'ext' && riskyExtCount > 0}
          extra={`将改名 ${changedPairs.length} 个视频（poster 同步改名）。${
            mode === 'ext' && riskyExtCount > 0
              ? `其中 ${riskyExtCount} 个文件真实容器不是 MP4，仅改后缀可能导致部分播放器无法识别。`
              : '不删除任何文件。'
          }`}
          onConfirm={execute}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

function SeqControls({
  seq,
  onChange
}: {
  seq: SeqOptions
  onChange: (next: SeqOptions) => void
}): React.JSX.Element {
  return (
    <div className="seq-controls">
      <label>
        排序
        <select
          value={seq.sortBy}
          onChange={(event) => onChange({ ...seq, sortBy: event.target.value as 'title' | 'size' })}
        >
          <option value="title">按标题</option>
          <option value="size">按大小</option>
        </select>
      </label>
      <label>
        方向
        <select
          value={seq.order}
          onChange={(event) => onChange({ ...seq, order: event.target.value as 'asc' | 'desc' })}
        >
          <option value="asc">正序</option>
          <option value="desc">倒序</option>
        </select>
      </label>
      <label>
        起始
        <input
          type="number"
          min={1}
          max={9999}
          value={seq.start}
          onChange={(event) =>
            onChange({
              ...seq,
              start: Math.max(1, Math.min(9999, Math.floor(Number(event.target.value)) || 1))
            })
          }
        />
      </label>
      <label>
        位数
        <input
          type="number"
          min={1}
          max={6}
          value={seq.digits}
          onChange={(event) => onChange({ ...seq, digits: Number(event.target.value) })}
        />
      </label>
      <label>
        分隔符
        <input
          className="sep-input"
          value={seq.separator}
          onChange={(event) => onChange({ ...seq, separator: event.target.value })}
        />
      </label>
    </div>
  )
}

export default RenamePage
