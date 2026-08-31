import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { Comic, ComicFormat, ComicMergeReport, ComicScanResult } from '../../../shared/types'
import {
  chapterDisplayName,
  comicCoverName,
  comicOutputName
} from '../../../shared/comic-rules.mjs'
import { applyRegexRules } from '../../../shared/rename-rules.mjs'
import ConfirmDialog from '../components/ConfirmDialog'
import ErrorBanner from '../components/ErrorBanner'
import { formatBytes, joinPath } from '../utils/format'
import { mediaUrl } from '../utils/media'
import { useWorkspaceSync } from '../utils/useWorkspaceSync'
import { useWorkspaceRequestVersion } from '../utils/useWorkspaceRequestVersion'

/** 漫画状态徽标 */
function comicBadge(comic: Comic): { text: string; tone: 'muted' | 'ok' | 'warn' | 'new' } {
  if (!comic.merged) return { text: '未合并', tone: 'muted' }
  if (comic.changedChapters.length > 0) return { text: '内容已变化', tone: 'warn' }
  if (comic.newChapters.length > 0)
    return { text: `+${comic.newChapters.length} 章更新`, tone: 'new' }
  return { text: `已合并 ${comic.merged.format.toUpperCase()}`, tone: 'ok' }
}

/**
 * 单行漫画条目（memo 隔离）：
 * 输入名称/正则预览的按键更新、任务事件、全局选中变化都会触发页面重渲染，
 * 逐行比较复杂 props 后只真正重绘变化行，避免数百行列表整列表重渲染、
 * 进而避免 Windows 上键盘输入与重命名执行期间肉眼可见的卡帧。
 */
const ComicListItem = memo(function ComicListItem({
  comic,
  checked,
  rebuild,
  mutating,
  scanning,
  name,
  regexActive,
  workspace,
  isOpen,
  onToggle,
  onNameChange,
  onToggleExpand
}: {
  comic: Comic
  checked: boolean
  rebuild: boolean
  mutating: boolean
  /** 扫描进行中：禁止输入名称，避免扫描结果覆盖正在编辑的草稿 */
  scanning: boolean
  name: string
  regexActive: boolean
  workspace: string
  isOpen: boolean
  onToggle: (relDir: string) => void
  onNameChange: (relDir: string, value: string) => void
  onToggleExpand: (relDir: string) => void
}): React.JSX.Element {
  const badge = comicBadge(comic)
  return (
    <div className="comic-item">
      <label className="comic-row">
        <input
          className="check-input"
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(comic.relDir)}
          disabled={
            mutating ||
            comic.imageCount === 0 ||
            (!comic.merged ? false : comic.newChapters.length === 0 && !rebuild)
          }
        />
        <span className="comic-cover">
          {comic.coverRel ? (
            <img
              src={mediaUrl(joinPath(workspace, joinPath(comic.relDir, comic.coverRel)))}
              alt={comic.name}
              loading="lazy"
            />
          ) : (
            <span className="comic-cover-empty" aria-label="暂无封面" />
          )}
        </span>
        <span className="comic-info">
          <input
            className="comic-name-input"
            value={name}
            aria-label={`${comic.name} 的漫画名称`}
            title={
              regexActive
                ? '正在显示批量替换预览；清空“正则查找”后可逐项编辑。'
                : '可直接编辑漫画名称'
            }
            disabled={scanning || mutating || regexActive}
            onClick={(event) => event.preventDefault()}
            onChange={(event) => onNameChange(comic.relDir, event.target.value)}
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
            onToggleExpand(comic.relDir)
          }}
        >
          {isOpen ? '收起' : '章节'}
        </button>
      </label>
      {isOpen && (
        <div className="comic-chapters">
          {comic.chapters.map((chapter) => {
            const isNew = comic.newChapters.some((c) => c.relDir === chapter.relDir)
            const isChanged = comic.changedChapters.includes(chapterDisplayName(chapter))
            return (
              <div key={chapter.relDir || '__flat__'} className="comic-chapter-row">
                <span>{chapterDisplayName(chapter)}</span>
                <span className="muted">{chapter.images.length} 图</span>
                {isNew && <span className="comic-badge comic-badge-new">新</span>}
                {isChanged && <span className="comic-badge comic-badge-warn">已变化</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
})

const COMIC_PAGE_SIZE = 100

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
  const [comicPage, setComicPage] = useState(0)
  // 删除确认绑定合并时的工作区，阻止切换目录后按相对路径误删。
  const reportWorkspaceRef = useRef<string | null>(null)
  const requests = useWorkspaceRequestVersion(workspace)

  // 启动时读取记忆的格式偏好
  useEffect(() => {
    window.api
      .getSettings()
      .then((settings) => setFormat(settings.comicFormat))
      .catch(() => {})
  }, [])

  /**
   * 扫描漫画工作区。为保证嵌套章节页的差异判断准确，任何刷新都做完整扫描；
   * light 参数仅保留 IPC 兼容，不再降低扫描完整性。
   */
  const scan = async (light = false): Promise<void> => {
    if (!workspace) return
    const requestWorkspace = workspace
    const requestVersion = requests.begin()
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const next = await window.api.scanComics(workspace, { light })
      if (!requests.isCurrent(requestVersion, requestWorkspace)) return
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
      setComicPage(0)
    } catch (err) {
      if (requests.isCurrent(requestVersion, requestWorkspace))
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requests.isCurrent(requestVersion, requestWorkspace)) setLoading(false)
    }
  }

  // 页面可见时的自动刷新只需目录名/清单（轻量），手动“刷新”按钮保持全量。
  useWorkspaceSync(workspace, active, () => scan(true))

  // 输入框保持高优先级即时响应，正则预览/关键词过滤降为低优先级派生计算：
  // 数百部漫画时每次按键的全量正则替换与过滤不阻塞渲染，避免 Windows 上输入卡顿。
  const deferredRegexPattern = useDeferredValue(regexPattern)
  const deferredKeyword = useDeferredValue(keyword)

  // 正则仅作为实时预览叠加在手工名称草稿之上：不会因输入过程改写草稿，清空查找条件即可恢复。
  const { previewNames, regexError } = useMemo(() => {
    const drafts = comicNames
    if (!deferredRegexPattern || !result) return { previewNames: drafts, regexError: '' }
    try {
      // 提前构造以识别非法表达式；实际替换仍复用共享规则。
      new RegExp(deferredRegexPattern, 'g')
      return {
        previewNames: Object.fromEntries(
          (result?.comics ?? []).map((comic) => [
            comic.relDir,
            applyRegexRules(drafts[comic.relDir] ?? comic.name, [
              { pattern: deferredRegexPattern, replacement: regexReplacement, flags: 'g' }
            ])
          ])
        ),
        regexError: ''
      }
    } catch {
      return { previewNames: drafts, regexError: '正则表达式无效，当前不会应用替换。' }
    }
  }, [comicNames, deferredRegexPattern, regexReplacement, result])

  const comics = useMemo(() => {
    const list = result?.comics ?? []
    const key = deferredKeyword.trim().toLowerCase()
    return key
      ? list.filter((comic) =>
          (previewNames[comic.relDir] ?? comic.name).toLowerCase().includes(key)
        )
      : list
  }, [result, deferredKeyword, previewNames])

  // 与当前目录名不同的条目数：正则激活时提示“保存名称”实际将改名多少部，避免误提交整批。
  const changedNameCount = useMemo(
    () =>
      (result?.comics ?? []).filter(
        (comic) => (previewNames[comic.relDir] ?? comic.name).trim() !== comic.relDir
      ).length,
    [result, previewNames]
  )

  // 扫描结果、搜索词、正则预览变化时回到第一页（在各自事件处理器中重置，避免 effect 内 setState）；
  // 编辑单行名称（comicNames 变化）不重置页码。
  const pageCount = Math.max(1, Math.ceil(comics.length / COMIC_PAGE_SIZE))
  const currentComicPage = Math.min(comicPage, pageCount - 1)
  const pagedComics = useMemo(
    () =>
      comics.slice(currentComicPage * COMIC_PAGE_SIZE, (currentComicPage + 1) * COMIC_PAGE_SIZE),
    [comics, currentComicPage]
  )

  const selectedComics = useMemo(
    () => (result?.comics ?? []).filter((comic) => selected.has(comic.relDir)),
    [result, selected]
  )
  const needRebuild = selectedComics.some((comic) => comic.changedChapters.length > 0)
  const comicMutating = merging || renaming || deleting

  // 回调必须保持稳定引用（useCallback + 函数式更新），否则 memo 化的行组件每次都会失效。
  const handleToggleComic = useCallback((relDir: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(relDir)) next.delete(relDir)
      else next.add(relDir)
      return next
    })
  }, [])
  const handleNameChange = useCallback((relDir: string, value: string): void => {
    setComicNames((prev) => ({ ...prev, [relDir]: value }))
  }, [])
  const handleToggleExpand = useCallback((relDir: string): void => {
    setExpanded((prev) => (prev === relDir ? null : relDir))
  }, [])

  const changeFormat = (next: ComicFormat): void => {
    setFormat(next)
    window.api.updateSettings({ comicFormat: next }).catch(() => {})
  }

  /**
   * 重命名完成后用 from→to 映射就地刷新列表，不触发任何图片扫描。
   * 章节图片路径相对漫画目录（不含目录名），重命名后无需改动；
   * 只需同步 relDir/name、名称草稿、勾选/展开状态，以及随漫画名变化的产物/封面文件名。
   */
  const applyRenameMapping = useCallback((renamed: Array<{ from: string; to: string }>): void => {
    const byFrom = new Map(renamed.map((item) => [item.from, item.to]))
    if (byFrom.size === 0) return
    setResult((prev) => {
      if (!prev) return prev
      const comics = prev.comics.map((comic) => {
        const to = byFrom.get(comic.relDir)
        if (!to || to === comic.relDir) return comic
        const merged = comic.merged
          ? {
              ...comic.merged,
              outputName: comicOutputName(to, comic.merged.format),
              coverName: comic.merged.coverName ? comicCoverName(to) : undefined
            }
          : null
        const coverRel =
          comic.merged?.coverName && comic.coverRel === comic.merged.coverName
            ? comicCoverName(to)
            : comic.coverRel
        return { ...comic, relDir: to, name: to, coverRel, merged }
      })
      return { ...prev, comics }
    })
    setComicNames((prev) => {
      const next: Record<string, string> = {}
      for (const [key, value] of Object.entries(prev)) {
        const to = byFrom.get(key)
        next[to ?? key] = to ?? value
      }
      return next
    })
    setSelected((prev) => new Set([...prev].map((relDir) => byFrom.get(relDir) ?? relDir)))
    setExpanded((prev) => (prev ? (byFrom.get(prev) ?? prev) : prev))
  }, [])

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
      // 校验失败/被占用等单项失败不再阻断整批，失败原因逐项展示，便于定位是哪部漫画的问题。
      if (outcome.failed.length > 0) {
        setError(
          `部分漫画改名失败：${outcome.failed
            .map((item) => `「${item.target}」${item.error}`)
            .join('；')}`
        )
      } else {
        setError('')
      }
      setNotice(
        `已重命名漫画 ${outcome.renamedCount} 部${outcome.failed.length ? `，失败 ${outcome.failed.length} 部` : ''}`
      )
      // 改名只涉及目录名，图片/章节结构一个都没变：用主进程返回的 from→to 映射就地更新列表，
      // 完全跳过扫描（几千页工作区也不会发生任何目录遍历）。失败项保持原名，不影响其他项。
      if (outcome.items.length > 0) applyRenameMapping(outcome.items)
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
      await scan(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const mergedImageCount = report?.merged.reduce((sum, item) => sum + item.images, 0) ?? 0
  const mergedSourceBytes = report?.merged.reduce((sum, item) => sum + item.sourceBytes, 0) ?? 0

  return (
    <div className="page comic-merge-page">
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
            onClick={() => void scan()}
            data-command="scan"
            disabled={!workspace || loading || comicMutating}
          >
            {loading ? '扫描中…' : '刷新'}
          </button>
          <button className="secondary" onClick={onOpenLibrary}>
            漫画库
          </button>
          {/* 主操作放在置顶的页头：随时可见，且不会被右下角任务浮岛遮挡。 */}
          {result && (
            <span className="muted comic-picked">
              已选 {selectedComics.length} 部{rebuild ? '（全量重建）' : ''}
            </span>
          )}
          {result &&
            (merging ? (
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
            ))}
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
                className="check-input"
                type="checkbox"
                checked={raw}
                onChange={(event) => setRaw(event.target.checked)}
                disabled={merging}
              />
              <span className="muted">原样模式</span>
            </label>
            <label className="confirm-check" title="忽略已有清单整体重打（章节内容变化时使用）">
              <input
                className="check-input"
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
              onChange={(event) => {
                setKeyword(event.target.value)
                setComicPage(0)
              }}
              disabled={loading || comicMutating}
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
              onChange={(event) => {
                setRegexPattern(event.target.value)
                setComicPage(0)
              }}
              disabled={loading || comicMutating}
            />
            <input
              className="comic-search"
              placeholder="替换为（可留空）"
              value={regexReplacement}
              onChange={(event) => {
                setRegexReplacement(event.target.value)
                setComicPage(0)
              }}
              disabled={loading || comicMutating}
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
                disabled={loading || comicMutating || Boolean(regexError)}
                title={`将把 ${changedNameCount} 部漫画目录改名为预览名称`}
              >
                保存名称{changedNameCount > 0 ? `（${changedNameCount} 部）` : ''}
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
            {pagedComics.map((comic) => (
              <ComicListItem
                key={comic.relDir}
                comic={comic}
                checked={selected.has(comic.relDir)}
                rebuild={rebuild}
                mutating={comicMutating}
                scanning={loading}
                name={previewNames[comic.relDir] ?? comic.name}
                regexActive={Boolean(regexPattern)}
                workspace={workspace}
                isOpen={expanded === comic.relDir}
                onToggle={handleToggleComic}
                onNameChange={handleNameChange}
                onToggleExpand={handleToggleExpand}
              />
            ))}
          </div>
          {comics.length > COMIC_PAGE_SIZE && (
            <nav className="comic-pagination" aria-label="漫画列表分页">
              <button
                className="secondary"
                disabled={currentComicPage === 0}
                onClick={() => setComicPage((value) => value - 1)}
              >
                上一页
              </button>
              <span className="muted">
                第 {currentComicPage + 1} / {pageCount} 页，每页 {COMIC_PAGE_SIZE} 部，共{' '}
                {comics.length} 部
              </span>
              <button
                className="secondary"
                disabled={currentComicPage >= pageCount - 1}
                onClick={() => setComicPage((value) => value + 1)}
              >
                下一页
              </button>
            </nav>
          )}
        </section>
      )}

      {report && (
        <section className="plan comic-report">
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
                      {item.repairedPages > 0 && (
                        <>
                          {' '}
                          · <span className="warn-text">修复 {item.repairedPages} 页损坏图</span>
                        </>
                      )}
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
              <p className="warning-text">
                ⚠️ 合并失败的漫画已移入工作区下的「合并失败」文件夹，处理好后拖回根目录即可重试。
              </p>
              {report.failed.map((item) => (
                <div key={item.target} className="comic-chapter-row">
                  <span className="danger-text">
                    {item.target}：{item.error}
                    {item.movedTo ? `（已移至 ${item.movedTo}）` : ''}
                    {item.moveError ? `（移动失败：${item.moveError}）` : ''}
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
