import { useMemo, useState } from 'react'
import type { ComicScanResult } from '../../../shared/types'
import ErrorBanner from '../components/ErrorBanner'
import VirtualGrid from '../components/VirtualGrid'
import WorkbenchEmptyState from '../components/WorkbenchEmptyState'
import WorkbenchHeader from '../components/WorkbenchHeader'
import { formatBytes, joinPath } from '../utils/format'
import { mediaUrl } from '../utils/media'
import { useWorkspaceSync } from '../utils/useWorkspaceSync'

/** 漫画库：已合并漫画的海报墙（封面 + 格式徽标 + 打开/定位），只读浏览 + 更新提醒。 */
function ComicLibraryPage({
  active,
  workspace,
  onChooseWorkspace,
  onOpenMerge
}: {
  active: boolean
  workspace: string
  onChooseWorkspace: () => Promise<void>
  onOpenMerge: () => void
}): React.JSX.Element {
  const [result, setResult] = useState<ComicScanResult | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    setError('')
    try {
      const next = await window.api.scanComics(workspace)
      setResult(next)
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // 页面可见时对比工作区指纹：有变化自动重扫
  useWorkspaceSync(workspace, active, refresh)

  const allMergedComics = useMemo(
    () => (result?.comics ?? []).filter((comic) => comic.merged),
    [result]
  )

  const mergedComics = useMemo(() => {
    const key = keyword.trim().toLowerCase()
    return key
      ? allMergedComics.filter((comic) => comic.name.toLowerCase().includes(key))
      : allMergedComics
  }, [allMergedComics, keyword])

  const updateCount = useMemo(
    () => allMergedComics.filter((comic) => comic.newChapters.length > 0).length,
    [allMergedComics]
  )

  const openComic = async (relDir: string, outputName: string): Promise<void> => {
    setNotice('')
    setError('')
    try {
      await window.api.openPath(joinPath(workspace, joinPath(relDir, outputName)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const revealComic = async (relDir: string, outputName: string): Promise<void> => {
    setError('')
    try {
      await window.api.revealPath(joinPath(workspace, joinPath(relDir, outputName)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="page">
      <WorkbenchHeader
        eyebrow="漫画书房 / 已归档"
        title="你的数字书架"
        description="浏览已整理的 EPUB 与 PDF；选择一本，即可交给系统阅读器继续阅读。"
        actions={
          <>
            <button className="secondary" onClick={onChooseWorkspace}>
              选择工作区
            </button>
            <button
              className="secondary"
              data-command="scan"
              onClick={refresh}
              disabled={!workspace || loading}
            >
              {loading ? '加载中…' : '刷新书架'}
            </button>
            <button onClick={onOpenMerge}>整理漫画</button>
          </>
        }
      />

      <section
        className="comic-library-overview workspace-overview workspace-overview-comic"
        aria-label="漫画库概览"
      >
        <div className="comic-library-workspace">
          <span>当前书房</span>
          <strong title={workspace || undefined}>{workspace || '尚未选择目录'}</strong>
        </div>
        <div className="comic-library-stat">
          <strong>{allMergedComics.length}</strong>
          <span>已归档</span>
        </div>
        <div className={`comic-library-stat ${updateCount > 0 ? 'has-updates' : ''}`}>
          <strong>{updateCount}</strong>
          <span>等待追更</span>
        </div>
      </section>

      {error && <ErrorBanner message={error} />}
      {notice && <p className="notice-inline">{notice}</p>}

      {loaded && allMergedComics.length > 0 && (
        <div className="library-toolbar comic-library-toolbar">
          <label className="comic-search-field">
            <span className="sr-only">搜索漫画</span>
            <input
              placeholder={`搜索 ${allMergedComics.length} 部漫画…`}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>
          <span className="comic-library-result-count" aria-live="polite">
            {keyword ? `找到 ${mergedComics.length} 部` : `共 ${allMergedComics.length} 部`}
          </span>
        </div>
      )}

      {mergedComics.length > 0 && (
        <VirtualGrid
          className="comic-shelf"
          items={mergedComics}
          minItemWidth={176}
          metaHeight={122}
          thumbnailRatio={3 / 4}
          renderItem={(comic, style) => (
            <article key={comic.relDir} data-spotlight="" className="comic-card" style={style}>
              <button
                className="comic-card-main"
                onClick={() => void openComic(comic.relDir, comic.merged!.outputName)}
                title="用系统默认应用打开"
                aria-label={`打开《${comic.name}》`}
              >
                <span className="comic-thumb">
                  {comic.coverRel ? (
                    <img
                      src={mediaUrl(joinPath(workspace, joinPath(comic.relDir, comic.coverRel)))}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="comic-cover-empty" aria-label="暂无封面">
                      暂无封面
                    </span>
                  )}
                  <span className="comic-format-badge">{comic.merged!.format.toUpperCase()}</span>
                  {comic.newChapters.length > 0 && (
                    <span className="comic-card-update">+{comic.newChapters.length}</span>
                  )}
                </span>
                <span className="comic-card-meta">
                  <b title={comic.name}>{comic.name}</b>
                  <span>
                    {comic.merged!.chapters.length} 章 <i aria-hidden="true">·</i>{' '}
                    {formatBytes(comic.merged!.outputBytes)}
                  </span>
                  <span className="comic-card-hint">点击打开阅读</span>
                </span>
              </button>
              <div className="comic-card-actions">
                <button
                  className="secondary"
                  onClick={() => void revealComic(comic.relDir, comic.merged!.outputName)}
                >
                  在文件夹中显示
                </button>
                {comic.newChapters.length > 0 && (
                  <button className="secondary comic-update-button" onClick={onOpenMerge}>
                    追更
                  </button>
                )}
              </div>
            </article>
          )}
        />
      )}

      {loaded && allMergedComics.length > 0 && mergedComics.length === 0 && (
        <WorkbenchEmptyState
          title="没有匹配的漫画"
          description="换一个名称试试，或清空搜索回到完整书架。"
          action={
            <button className="secondary" onClick={() => setKeyword('')}>
              清空搜索
            </button>
          }
        />
      )}

      {loaded && allMergedComics.length === 0 && (
        <WorkbenchEmptyState
          title="书架还是空的"
          description="把章节整理成 EPUB 或 PDF 后，它们会带着封面出现在这里。"
          action={<button onClick={onOpenMerge}>去整理漫画</button>}
        />
      )}
      {!loaded && (
        <WorkbenchEmptyState
          title="选择漫画工作区后开始"
          description="指向已合并的工作区，刷新后即可生成数字书架。"
          action={<button onClick={() => void onChooseWorkspace()}>选择工作区</button>}
        />
      )}
    </div>
  )
}

export default ComicLibraryPage
