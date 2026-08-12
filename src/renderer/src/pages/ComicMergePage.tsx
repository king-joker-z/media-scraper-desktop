import { useEffect, useMemo, useRef, useState } from 'react'
import type { Comic, ComicFormat, ComicMergeReport, ComicScanResult } from '../../../shared/types'
import { chapterDisplayName } from '../../../shared/comic-rules.mjs'
import { applyRegexRules } from '../../../shared/rename-rules.mjs'
import ConfirmDialog from '../components/ConfirmDialog'
import ErrorBanner from '../components/ErrorBanner'
import { formatBytes, joinPath } from '../utils/format'
import { mediaUrl } from '../utils/media'
import { useWorkspaceSync } from '../utils/useWorkspaceSync'

/** 漫画状态徽标 */
function comicBadge(comic: Comic): { text: string; tone: 'muted' | 'ok' | 'warn' | 'new' } {
  if (!comic.merged) return { text: '未合并', tone: 'muted' }
  if (comic.changedChapters.length > 0) return { text: '内容已变化', tone: 'warn' }
  if (comic.newChapters.length > 0)
    return { text: `+${comic.newChapters.length} 章更新`, tone: 'new' }
  return { text: `已合并 ${comic.merged.format.toUpperCase()}`, tone: 'ok' }
}

/**
 * 漫画合并：扫描漫画工作区 → 勾选漫画 → 选格式（EPUB/PDF）→ 执行 → 报告 → 删除源图。
 * 已合并且有新章节的漫画走增量追加；章节内容变化的需要勾选「全量重建」。
 */
function ComicMergePage({
  active,
  workspace,
  onChooseWorkspace,
  onOpenLibrary
}: {
  active: boolean
  workspace: string
  onChooseWorkspace: () => Promise<void>
  onOpenLibrary: () => void
}): React.JSX.Element {
  const [result, setResult] = useState<ComicScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [merging, setMerging] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [format, setFormat] = useState<ComicFormat>('epub')
  const [raw, setRaw] = useState(false)
  const [rebuild, setRebuild] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [report, setReport] = useState<ComicMergeReport | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [comicNames, setComicNames] = useState<Record<string, string>>({})
  const [regexPattern, setRegexPattern] = useState('')
  const [regexReplacement, setRegexReplacement] = useState('')
  // 删除确认绑定合并时的工作区，阻止切换目录后按相对路径误删。
  const reportWorkspaceRef = useRef<string | null>(null)

  // 启动时读取记忆的格式偏好
  useEffect(() => {
    window.api
      .getSettings()
      .then((settings) => setFormat(settings.comicFormat))
      .catch(() => {})
  }, [])

  const scan = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const next = await window.api.scanComics(workspace)
      setResult(next)
      setComicNames(Object.fromEntries(next.comics.map((comic) => [comic.relDir, comic.name])))
      // 默认勾选：未合并 + 有新章节可更新的（内容已变化需人工决策，不默认勾）
      setSelected(
        new Set(
          next.comics
            .filter(
              (comic) =>
                (!comic.merged && comic.imageCount > 0) ||
                (comic.merged && comic.newChapters.length > 0 && comic.changedChapters.length === 0)
            )
            .map((comic) => comic.relDir)
        )
      )
      setReport(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useWorkspaceSync(workspace, active, scan)

  // 正则仅作为实时预览叠加在手工名称草稿之上：不会因输入过程改写草稿，清空查找条件即可恢复。
  const { previewNames, regexError } = useMemo(() => {
    const drafts = comicNames
    if (!regexPattern) return { previewNames: drafts, regexError: '' }
    try {
      // 提前构造以识别非法表达式；实际替换仍复用共享规则。
      new RegExp(regexPattern, 'g')
      return {
        previewNames: Object.fromEntries(
          (result?.comics ?? []).map((comic) => [
            comic.relDir,
            applyRegexRules(drafts[comic.relDir] ?? comic.name, [
              { pattern: regexPattern, replacement: regexReplacement, flags: 'g' }
            ])
          ])
        ),
        regexError: ''
      }
    } catch {
      return { previewNames: drafts, regexError: '正则表达式无效，当前不会应用替换。' }
    }
  }, [comicNames, regexPattern, regexReplacement, result])

  const comics = useMemo(() => {
    const list = result?.comics ?? []
    const key = keyword.trim().toLowerCase()
    return key
      ? list.filter((comic) =>
          (previewNames[comic.relDir] ?? comic.name).toLowerCase().includes(key)
        )
      : list
  }, [result, keyword, previewNames])

  const selectedComics = useMemo(
    () => (result?.comics ?? []).filter((comic) => selected.has(comic.relDir)),
    [result, selected]
  )
  const needRebuild = selectedComics.some((comic) => comic.changedChapters.length > 0)
  const comicMutating = merging || renaming || deleting

  const toggle = (relDir: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(relDir)) next.delete(relDir)
      else next.add(relDir)
      return next
    })
  }

  const changeFormat = (next: ComicFormat): void => {
    setFormat(next)
    window.api.updateSettings({ comicFormat: next }).catch(() => {})
  }

  const renameComics = async (): Promise<void> => {
    if (!result) return
    const items = result.comics
      .map((comic) => ({
        relDir: comic.relDir,
        newName: (previewNames[comic.relDir] ?? comic.name).trim()
      }))
      .filter((item) => item.relDir !== item.newName)
    if (items.length === 0) return
    setRenaming(true)
    setError('')
    setNotice('')
    try {
      const outcome = await window.api.renameComics(workspace, items)
      setNotice(
        `已重命名漫画 ${outcome.renamedCount} 部${outcome.failed.length ? `，失败 ${outcome.failed.length} 部` : ''}`
      )
      await scan()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRenaming(false)
    }
  }

  const execute = async (): Promise<void> => {
    if (selectedComics.length === 0) return
    reportWorkspaceRef.current = null
    setMerging(true)
    setError('')
    setNotice('')
    setReport(null)
    try {
      const next = await window.api.mergeComics(
        workspace,
        selectedComics.map((comic) => comic.relDir),
        format,
        { raw, rebuild }
      )
      setReport(next)
      if (!next.cancelled && next.merged.length > 0) {
        reportWorkspaceRef.current = workspace
        // 合并成功后询问删除源图片
        setConfirmDelete(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMerging(false)
    }
  }

  const deleteSources = async (): Promise<void> => {
    const reportWorkspace = reportWorkspaceRef.current
    if (!report || !reportWorkspace) return
    if (workspace !== reportWorkspace) {
      setConfirmDelete(false)
      setError('工作区已切换，为避免误删，已取消删除源图片确认。请回到原工作区后重新扫描。')
      return
    }
    setConfirmDelete(false)
    setDeleting(true)
    setError('')
    try {
      const outcome = await window.api.deleteComicSources(
        reportWorkspace,
        report.merged.map((item) => item.relDir)
      )
      setNotice(
        `已删除源图片 ${outcome.deletedCount} 张${
          outcome.failed.length > 0 ? `，失败 ${outcome.failed.length} 项` : ''
        }（产物与清单保留）`
      )
      setReport(null)
      reportWorkspaceRef.current = null
      await scan()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const mergedImageCount = report?.merged.reduce((sum, item) => sum + item.images, 0) ?? 0
  const mergedSourceBytes = report?.merged.reduce((sum, item) => sum + item.sourceBytes, 0) ?? 0

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">漫画合并</p>
          <h1>章节合并为 EPUB / PDF</h1>
          <p className="muted">
            每个子文件夹是一部漫画，章节目录与图片按自然顺序合并；已合并的漫画追更后只需追加新章节。
          </p>
        </div>
        <div className="actions">
          <button
            className="secondary"
            onClick={onChooseWorkspace}
            disabled={comicMutating || confirmDelete}
          >
            选择工作区
          </button>
          <button
            className="secondary"
            onClick={scan}
            disabled={!workspace || loading || comicMutating}
          >
            {loading ? '扫描中…' : '刷新'}
          </button>
          <button className="secondary" onClick={onOpenLibrary}>
            漫画库
          </button>
        </div>
      </header>

      <section className="path-card">
        <span>漫画工作区</span>
        <strong>{workspace || '尚未选择目录'}</strong>
      </section>

      {error && <ErrorBanner message={error} />}
      {notice && <p className="notice-inline">{notice}</p>}

      {result && (
        <section className="plan comic-merge-plan">
          <div className="comic-toolbar">
            <div className="mode-tabs" title="输出格式（切换后记忆）">
              <button
                className={`mode-tab ${format === 'epub' ? 'active' : ''}`}
                onClick={() => changeFormat('epub')}
              >
                EPUB（阅读器）
              </button>
              <button
                className={`mode-tab ${format === 'pdf' ? 'active' : ''}`}
                onClick={() => changeFormat('pdf')}
              >
                PDF（通用）
              </button>
            </div>
            <label
              className="confirm-check"
              title="不重编码、不缩放，原图直接打包（体积更大；PDF 仅 JPG/PNG 可直嵌）"
            >
              <input
                type="checkbox"
                checked={raw}
                onChange={(event) => setRaw(event.target.checked)}
                disabled={merging}
              />
              <span className="muted">原样模式</span>
            </label>
            <label className="confirm-check" title="忽略已有清单整体重打（章节内容变化时使用）">
              <input
                type="checkbox"
                checked={rebuild}
                onChange={(event) => setRebuild(event.target.checked)}
                disabled={merging}
              />
              <span className="muted">全量重建</span>
            </label>
            <input
              className="comic-search"
              placeholder={`搜索 ${result.comics.length} 部漫画…`}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>

          <div className="comic-toolbar">
            <div className="comic-name-heading">
              <strong>批量替换名称</strong>
              <span className="muted">输入后即时预览；清空“查找”可恢复手工编辑的名称。</span>
            </div>
            <input
              className="comic-search"
              placeholder="正则查找"
              value={regexPattern}
              onChange={(event) => setRegexPattern(event.target.value)}
              disabled={comicMutating}
            />
            <input
              className="comic-search"
              placeholder="替换为（可留空）"
              value={regexReplacement}
              onChange={(event) => setRegexReplacement(event.target.value)}
              disabled={comicMutating}
            />
            {regexPattern && !regexError && (
              <span className="regex-preview-status">实时预览中</span>
            )}
            {renaming ? (
              <button className="secondary" onClick={() => void window.api.cancelComicRename()}>
                取消改名
              </button>
            ) : (
              <button
                className="secondary"
                onClick={() => void renameComics()}
                disabled={comicMutating || Boolean(regexError)}
              >
                保存名称
              </button>
            )}
          </div>

          {regexError && <p className="warning-text">⚠️ {regexError}</p>}

          {needRebuild && !rebuild && (
            <p className="warning-text">
              ⚠️ 选中的漫画存在「内容已变化」的章节，需勾选「全量重建」后才能合并。
            </p>
          )}

          {comics.length === 0 && keyword && <p className="muted">没有匹配的漫画。</p>}

          <div className="comic-list" tabIndex={0}>
            {comics.map((comic) => {
              const badge = comicBadge(comic)
              const isOpen = expanded === comic.relDir
              return (
                <div key={comic.relDir} className="comic-item">
                  <label className="comic-row">
                    <input
                      type="checkbox"
                      checked={selected.has(comic.relDir)}
                      onChange={() => toggle(comic.relDir)}
                      disabled={
                        comicMutating ||
                        comic.imageCount === 0 ||
                        (!comic.merged ? false : comic.newChapters.length === 0 && !rebuild)
                      }
                    />
                    <span className="comic-cover">
                      {comic.coverRel ? (
                        <img
                          src={mediaUrl(
                            joinPath(workspace, joinPath(comic.relDir, comic.coverRel))
                          )}
                          alt={comic.name}
                          loading="lazy"
                        />
                      ) : (
                        <span className="comic-cover-empty">📚</span>
                      )}
                    </span>
                    <span className="comic-info">
                      <input
                        className="comic-name-input"
                        value={previewNames[comic.relDir] ?? comic.name}
                        aria-label={`${comic.name} 的漫画名称`}
                        title={
                          regexPattern
                            ? '正在显示批量替换预览；清空“正则查找”后可逐项编辑。'
                            : '可直接编辑漫画名称'
                        }
                        disabled={comicMutating || Boolean(regexPattern)}
                        onClick={(event) => event.preventDefault()}
                        onChange={(event) =>
                          setComicNames((prev) => ({ ...prev, [comic.relDir]: event.target.value }))
                        }
                      />
                      <span className="muted">
                        {comic.chapters.length} 章 · {comic.imageCount} 图
                        {comic.merged ? ` · 产物 ${formatBytes(comic.merged.outputBytes)}` : ''}
                      </span>
                    </span>
                    <span className={`comic-badge comic-badge-${badge.tone}`}>{badge.text}</span>
                    <button
                      className="secondary comic-expand"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setExpanded(isOpen ? null : comic.relDir)
                      }}
                    >
                      {isOpen ? '收起' : '章节'}
                    </button>
                  </label>
                  {isOpen && (
                    <div className="comic-chapters">
                      {comic.chapters.map((chapter) => {
                        const isNew = comic.newChapters.some((c) => c.relDir === chapter.relDir)
                        const isChanged = comic.changedChapters.includes(
                          chapterDisplayName(chapter)
                        )
                        return (
                          <div key={chapter.relDir || '__flat__'} className="comic-chapter-row">
                            <span>{chapterDisplayName(chapter)}</span>
                            <span className="muted">{chapter.images.length} 图</span>
                            {isNew && <span className="comic-badge comic-badge-new">新</span>}
                            {isChanged && (
                              <span className="comic-badge comic-badge-warn">已变化</span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="plan-footer">
            <span className="muted">
              已选 {selectedComics.length} 部{rebuild ? '（全量重建）' : ''}
            </span>
            {merging ? (
              <button className="secondary" onClick={() => void window.api.cancelComicMerge()}>
                取消合并
              </button>
            ) : (
              <button
                onClick={execute}
                disabled={selectedComics.length === 0 || deleting || (needRebuild && !rebuild)}
              >
                {`合并 ${selectedComics.length} 部为 ${format.toUpperCase()}`}
              </button>
            )}
          </div>
        </section>
      )}

      {report && (
        <section className="plan">
          <h2>合并报告</h2>
          {report.merged.length > 0 && (
            <div className="comic-report-list">
              {report.merged.map((item) => (
                <div key={item.relDir} className="comic-chapter-row">
                  <span>
                    {item.name}
                    <span className="muted">
                      {item.mode === 'update' ? '（增量追加）' : '（全量）'} · {item.chapters} 章 ·{' '}
                      {item.images} 图
                    </span>
                  </span>
                  <span className="muted">
                    {formatBytes(item.sourceBytes)} → {formatBytes(item.bytes)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {report.failed.length > 0 && (
            <div className="comic-report-list">
              {report.failed.map((item) => (
                <div key={item.target} className="comic-chapter-row">
                  <span className="danger-text">
                    {item.target}：{item.error}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="muted">
            {report.cancelled ? '已取消。' : ''}耗时 {(report.durationMs / 1000).toFixed(1)}s
          </p>
        </section>
      )}

      {result && result.comics.length === 0 && (
        <section className="empty">
          <h2>没有找到漫画</h2>
          <p>漫画工作区的每个一级子文件夹视为一部漫画（子文件夹为章节，或直接平铺图片）。</p>
        </section>
      )}
      {!result && !loading && (
        <section className="empty">
          <h2>选择漫画工作区后开始</h2>
          <p>指向存放漫画的根目录，扫描后可批量合并为 EPUB / PDF。</p>
        </section>
      )}

      {confirmDelete && report && (
        <ConfirmDialog
          title="删除已合并的源图片？"
          deleteCount={mergedImageCount}
          deleteBytes={mergedSourceBytes}
          danger={false}
          recoverable
          extra="仅删除已合并章节内的图片；EPUB/PDF 产物、合并清单与封面缩略图保留。删除后追更仍可增量追加。"
          ackLabel="我已确认，删除源图片"
          onConfirm={deleteSources}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}

export default ComicMergePage
