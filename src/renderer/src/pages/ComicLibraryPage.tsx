import { useMemo, useState } from 'react'
import type { ComicScanResult } from '../../../shared/types'
import ErrorBanner from '../components/ErrorBanner'
import VirtualGrid from '../components/VirtualGrid'
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

  const mergedComics = useMemo(() => {
    const list = (result?.comics ?? []).filter((comic) => comic.merged)
    const key = keyword.trim().toLowerCase()
    return key ? list.filter((comic) => comic.name.toLowerCase().includes(key)) : list
  }, [result, keyword])

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
    try {
      await window.api.revealOpLog(joinPath(workspace, joinPath(relDir, outputName)))
    } catch {
      // 定位失败静默（文件被移走等）
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">漫画库</p>
          <h1>已合并漫画</h1>
          <p className="muted">海报墙浏览已合并的 EPUB/PDF 产物，点击用系统默认应用打开阅读。</p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onChooseWorkspace}>
            选择工作区
          </button>
          <button className="secondary" onClick={refresh} disabled={!workspace || loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
          <button className="secondary" onClick={onOpenMerge}>
            去合并
          </button>
        </div>
      </header>

      <section className="path-card">
        <span>漫画工作区</span>
        <strong>{workspace || '尚未选择目录'}</strong>
      </section>

      {error && <ErrorBanner message={error} />}
      {notice && <p className="notice-inline">{notice}</p>}

      {loaded && mergedComics.length > 0 && (
        <div className="library-toolbar">
          <input
            placeholder={`搜索 ${mergedComics.length} 部漫画…`}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </div>
      )}

      {mergedComics.length > 0 && (
        <VirtualGrid
          items={mergedComics}
          renderItem={(comic, style) => (
            <div key={comic.relDir} className="video-card comic-card" style={style}>
              <button
                className="comic-card-main"
                onClick={() => void openComic(comic.relDir, comic.merged!.outputName)}
                title="用系统默认应用打开"
              >
                <span className="video-thumb comic-thumb">
                  {comic.coverRel ? (
                    <img
                      src={mediaUrl(joinPath(workspace, joinPath(comic.relDir, comic.coverRel)))}
                      alt={comic.name}
                      loading="lazy"
                    />
                  ) : (
                    <span className="comic-cover-empty" aria-label="暂无封面" />
                  )}
                  <span className="comic-format-badge">{comic.merged!.format.toUpperCase()}</span>
                </span>
                <span className="video-meta">
                  <b>{comic.name}</b>
                  <span className="muted">
                    {comic.merged!.chapters.length} 章 · {formatBytes(comic.merged!.outputBytes)}
                  </span>
                  {comic.newChapters.length > 0 && (
                    <span className="comic-badge comic-badge-new">
                      有 {comic.newChapters.length} 章更新
                    </span>
                  )}
                </span>
              </button>
              <div className="comic-card-actions">
                <button
                  className="secondary"
                  onClick={() => void revealComic(comic.relDir, comic.merged!.outputName)}
                >
                  定位
                </button>
                {comic.newChapters.length > 0 && (
                  <button className="secondary" onClick={onOpenMerge}>
                    去更新
                  </button>
                )}
              </div>
            </div>
          )}
        />
      )}

      {loaded && mergedComics.length === 0 && (
        <section className="empty">
          <h2>漫画库为空</h2>
          <p>先到「漫画合并」把漫画章节打包成 EPUB/PDF，这里就会变成书架。</p>
        </section>
      )}
      {!loaded && (
        <section className="empty">
          <h2>选择漫画工作区后开始</h2>
          <p>指向已合并的工作区，点击「刷新」生成书架。</p>
        </section>
      )}
    </div>
  )
}

export default ComicLibraryPage
