import { useCallback, useEffect, useRef, useState } from 'react'
import CleanPage from './pages/CleanPage'
import ComicLibraryPage from './pages/ComicLibraryPage'
import ComicMergePage from './pages/ComicMergePage'
import DedupePage from './pages/DedupePage'
import LibraryPage from './pages/LibraryPage'
import MergePage from './pages/MergePage'
import NfoPage from './pages/NfoPage'
import PosterPage from './pages/PosterPage'
import RenamePage from './pages/RenamePage'
import SettingsPage from './pages/SettingsPage'
import TaskCenter from './components/TaskCenter'
import TaskProgress from './components/TaskProgress'
import ErrorBoundary from './components/ErrorBoundary'
import { prunePlayPositions } from './utils/media'
import { applyTheme } from './utils/theme'
import { basenameOf } from './utils/format'
import type { AppModule } from '../../shared/types'

export type PageKey =
  | 'clean'
  | 'merge'
  | 'rename'
  | 'poster'
  | 'nfo'
  | 'dedupe'
  | 'library'
  | 'settings'
  | 'comic-merge'
  | 'comic-library'

const VIDEO_NAV_ITEMS: { key: PageKey; icon: string; label: string }[] = [
  { key: 'clean', icon: '🧹', label: '目录清理' },
  { key: 'merge', icon: '🎬', label: '视频合并' },
  { key: 'rename', icon: '✏️', label: '批量重命名' },
  { key: 'poster', icon: '🖼️', label: '封面管理' },
  { key: 'nfo', icon: '📦', label: 'NFO 归档' },
  { key: 'dedupe', icon: '🧬', label: '视频去重' },
  { key: 'library', icon: '📺', label: '媒体库' },
  { key: 'settings', icon: '⚙️', label: '设置' }
]

const COMIC_NAV_ITEMS: { key: PageKey; icon: string; label: string }[] = [
  { key: 'comic-merge', icon: '📚', label: '漫画合并' },
  { key: 'comic-library', icon: '📖', label: '漫画库' },
  { key: 'settings', icon: '⚙️', label: '设置' }
]

const MODULE_META: Record<AppModule, { icon: string; name: string; home: PageKey }> = {
  video: { icon: '🎞️', name: '视频工坊', home: 'clean' },
  comic: { icon: '📚', name: '漫画书房', home: 'comic-merge' }
}

function App(): React.JSX.Element {
  // null = 显示模块选择页（首次启动 / 主动返回）
  const [module, setModule] = useState<AppModule | null>(null)
  const [page, setPage] = useState<PageKey>('clean')
  const [workspaces, setWorkspaces] = useState<Record<AppModule, string>>({ video: '', comic: '' })
  const [recents, setRecents] = useState<Record<AppModule, string[]>>({ video: [], comic: [] })
  const [showRecents, setShowRecents] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const dragDepth = useRef(0)

  const workspace = module ? workspaces[module] : ''
  const moduleRecents = module ? recents[module] : []

  // 启动初始化：应用主题、恢复上次模块与双工作区（media:// 白名单同步注册）、
  // 请求系统通知权限、清理过期播放进度缓存
  useEffect(() => {
    window.api
      .getSettings()
      .then(async (settings) => {
        applyTheme(settings.theme, settings.themePalette)
        setRecents({
          video: settings.recentWorkspaces,
          comic: settings.comicRecentWorkspaces
        })
        const nextWorkspaces = { video: '', comic: '' }
        const lastVideo = settings.recentWorkspaces[0]
        if (lastVideo) {
          const valid = await window.api.useWorkspace(lastVideo, 'video').catch(() => null)
          if (valid) nextWorkspaces.video = valid
        }
        const lastComic = settings.comicWorkspace || settings.comicRecentWorkspaces[0]
        if (lastComic) {
          const valid = await window.api.useWorkspace(lastComic, 'comic').catch(() => null)
          if (valid) nextWorkspaces.comic = valid
        }
        setWorkspaces(nextWorkspaces)
        if (settings.activeModule) {
          setModule(settings.activeModule)
          setPage(MODULE_META[settings.activeModule].home)
        }
      })
      .catch(() => {})
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
    prunePlayPositions()
  }, [])

  /** 切换模块（运行时灵活切换，双模块页面状态各自保留） */
  const switchModule = useCallback((next: AppModule | null): void => {
    setModule(next)
    setShowRecents(false)
    if (next) {
      setPage(MODULE_META[next].home)
      window.api.updateSettings({ activeModule: next }).catch(() => {})
    }
  }, [])

  const refreshRecents = useCallback((): void => {
    window.api
      .getSettings()
      .then((settings) =>
        setRecents({
          video: settings.recentWorkspaces,
          comic: settings.comicRecentWorkspaces
        })
      )
      .catch(() => {})
  }, [])

  const chooseWorkspace = useCallback(async (): Promise<void> => {
    if (!module) return
    const selected = await window.api.selectWorkspace(module)
    if (selected) {
      setWorkspaces((prev) => ({ ...prev, [module]: selected }))
      refreshRecents()
    }
  }, [module, refreshRecents])

  // 命名不能以 use 开头，否则会被 react-hooks 规则误判为 Hook
  const openWorkspace = useCallback(
    async (path: string): Promise<void> => {
      if (!module) return
      try {
        const valid = await window.api.useWorkspace(path, module)
        setWorkspaces((prev) => ({ ...prev, [module]: valid }))
        refreshRecents()
      } catch {
        // 无效目录（不存在/不可读）忽略
      }
    },
    [module, refreshRecents]
  )

  // 拖拽文件夹到窗口任意位置即可设为当前模块工作区（Electron 39 需经 webUtils 取路径）
  const onDragEnter = (event: React.DragEvent): void => {
    if (![...event.dataTransfer.types].includes('Files')) return
    event.preventDefault()
    dragDepth.current += 1
    setDropActive(true)
  }
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropActive(false)
  }
  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    dragDepth.current = 0
    setDropActive(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    const path = window.api.pathForFile(file)
    if (path) void openWorkspace(path)
  }

  // 所有模块页面常驻挂载：切换只隐藏不卸载，扫描结果/报告等状态完整保留；
  // 页面重新可见时由 useWorkspaceSync 对比工作区指纹决定是否自动重扫
  // （去重/体检为重型扫描，页面内手动触发，不接自动重扫）。
  const modulePages: { key: PageKey; element: React.JSX.Element }[] = [
    {
      key: 'clean',
      element: (
        <CleanPage
          active={module === 'video' && page === 'clean'}
          workspace={workspaces.video}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'merge',
      element: (
        <MergePage
          active={module === 'video' && page === 'merge'}
          workspace={workspaces.video}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'rename',
      element: (
        <RenamePage
          active={module === 'video' && page === 'rename'}
          workspace={workspaces.video}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'poster',
      element: (
        <PosterPage
          active={module === 'video' && page === 'poster'}
          workspace={workspaces.video}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'nfo',
      element: (
        <NfoPage
          active={module === 'video' && page === 'nfo'}
          workspace={workspaces.video}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'dedupe',
      element: (
        <DedupePage
          active={module === 'video' && page === 'dedupe'}
          workspace={workspaces.video}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'library',
      element: (
        <LibraryPage
          active={module === 'video' && page === 'library'}
          workspace={workspaces.video}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'comic-merge',
      element: (
        <ComicMergePage
          active={module === 'comic' && page === 'comic-merge'}
          workspace={workspaces.comic}
          onChooseWorkspace={chooseWorkspace}
          onOpenLibrary={() => setPage('comic-library')}
        />
      )
    },
    {
      key: 'comic-library',
      element: (
        <ComicLibraryPage
          active={module === 'comic' && page === 'comic-library'}
          workspace={workspaces.comic}
          onChooseWorkspace={chooseWorkspace}
          onOpenMerge={() => setPage('comic-merge')}
        />
      )
    },
    { key: 'settings', element: <SettingsPage /> }
  ]

  // 模块选择页：启动（未记忆模块）或主动切换时展示
  if (!module) {
    return (
      <div className="module-picker">
        <div className="module-picker-drag" />
        <p className="eyebrow">Media Scraper</p>
        <h1>选择你的工作模式</h1>
        <p className="muted">随时可从侧边栏返回此页切换模块，两个模块的页面状态各自保留。</p>
        <div className="module-cards">
          {(Object.keys(MODULE_META) as AppModule[]).map((key) => (
            <button
              key={key}
              className={`module-card module-card-${key}`}
              onClick={() => switchModule(key)}
            >
              <span className="module-card-icon">{MODULE_META[key].icon}</span>
              <span className="module-card-name">{MODULE_META[key].name}</span>
              <span className="module-card-desc">
                {key === 'video'
                  ? '清理 · 合并 · 重命名 · 封面 · 归档 · 去重 · 体检'
                  : '章节合并 EPUB/PDF · 追更增量追加 · 漫画库'}
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  const navItems = module === 'video' ? VIDEO_NAV_ITEMS : COMIC_NAV_ITEMS

  return (
    <div
      className="app-shell"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <aside className="sidebar">
        <div className="sidebar-drag" />
        <div className="sidebar-brand">
          <button
            className="module-switch"
            title="切换模块（视频 / 漫画）"
            onClick={() => switchModule(null)}
          >
            <span className="brand-icon">{MODULE_META[module].icon}</span>
            <span className="brand-name">{MODULE_META[module].name}</span>
            <span className="module-switch-caret">⇄</span>
          </button>
        </div>
        <div className="workspace-host">
          <button className="workspace-button" onClick={chooseWorkspace} title={workspace}>
            <span className="workspace-label">{module === 'video' ? '工作区' : '漫画工作区'}</span>
            <span className="workspace-value">
              {workspace ? basenameOf(workspace) : '点击选择 / 拖入文件夹'}
            </span>
          </button>
          {moduleRecents.length > 0 && (
            <button
              className="recents-toggle"
              title="最近使用的工作区"
              onClick={() => setShowRecents((v) => !v)}
            >
              🕘 最近
            </button>
          )}
          {showRecents && moduleRecents.length > 0 && (
            <>
              <div className="recents-mask" onClick={() => setShowRecents(false)} />
              <div className="recents-pop">
                {moduleRecents.map((path) => (
                  <button
                    key={path}
                    className={`recents-item ${path === workspace ? 'active' : ''}`}
                    title={path}
                    onClick={() => {
                      setShowRecents(false)
                      void openWorkspace(path)
                    }}
                  >
                    <b>{basenameOf(path)}</b>
                    <span>{path}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={`nav-item ${page === item.key ? 'active' : ''}`}
              onClick={() => setPage(item.key)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">v1.4.0 · 本地处理，隐私安全</div>
      </aside>
      <main className="content">
        {modulePages.map((item) => (
          <div key={item.key} className={`page-host ${page === item.key ? '' : 'page-hidden'}`}>
            <ErrorBoundary>{item.element}</ErrorBoundary>
          </div>
        ))}
      </main>
      {dropActive && (
        <div className="drop-overlay">
          <div className="drop-hint">松开以设为{module === 'video' ? '' : '漫画'}工作区</div>
        </div>
      )}
      <TaskProgress />
      <TaskCenter />
    </div>
  )
}

export default App
