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
import AppToaster from './components/AppToaster'
import TaskCenter from './components/TaskCenter'
import TaskIsland from './components/TaskIsland'
import { useTaskFeed } from './components/useTaskFeed'
import ErrorBanner from './components/ErrorBanner'
import ErrorBoundary from './components/ErrorBoundary'
import CommandPalette from './components/CommandPalette'
import ConfirmDialog from './components/ConfirmDialog'
import CursorTrail from './components/CursorTrail'
import Magnetic from './components/Magnetic'
import HudCorners from './components/hud/HudCorners'
import TerminalAtmosphere from './components/hud/TerminalAtmosphere'
import { prunePlayPositions } from './utils/media'
import { useSpotlightHover } from './utils/spotlight'
import {
  applyBackgroundAppearance,
  applyPerformanceMode,
  applyPlatformAppearance,
  applyTheme,
  DEFAULT_BACKGROUND_APPEARANCE
} from './utils/theme'
import { getPlatformAppearanceDefaults } from './utils/appearance-defaults'
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

type IconName =
  | 'archive'
  | 'book'
  | 'brush'
  | 'film'
  | 'folder'
  | 'image'
  | 'library'
  | 'merge'
  | 'recent'
  | 'rename'
  | 'settings'
  | 'spark'

const VIDEO_NAV_ITEMS: { key: PageKey; icon: IconName; label: string }[] = [
  { key: 'clean', icon: 'brush', label: '目录清理' },
  { key: 'merge', icon: 'merge', label: '视频合并' },
  { key: 'rename', icon: 'rename', label: '批量重命名' },
  { key: 'poster', icon: 'image', label: '封面管理' },
  { key: 'nfo', icon: 'archive', label: 'NFO 归档' },
  { key: 'dedupe', icon: 'spark', label: '视频去重' },
  { key: 'library', icon: 'library', label: '媒体库' },
  { key: 'settings', icon: 'settings', label: '设置' }
]

const COMIC_NAV_ITEMS: { key: PageKey; icon: IconName; label: string }[] = [
  { key: 'comic-merge', icon: 'merge', label: '漫画合并' },
  { key: 'comic-library', icon: 'book', label: '漫画库' },
  { key: 'settings', icon: 'settings', label: '设置' }
]

const MODULE_META: Record<AppModule, { icon: IconName; name: string; home: PageKey }> = {
  video: { icon: 'film', name: '视频工坊', home: 'clean' },
  comic: { icon: 'book', name: '漫画书房', home: 'comic-merge' }
}

const PAGE_COMMAND_ACTIONS: Partial<
  Record<PageKey, { id: string; label: string; description: string; selector: string }[]>
> = {
  clean: [
    {
      id: 'scan',
      label: '生成清理计划',
      description: '扫描当前工作区并预览清理结果',
      selector: '[data-command="scan"]'
    }
  ],
  merge: [
    {
      id: 'scan',
      label: '扫描合并片段',
      description: '读取视频编码、时长与方向信息',
      selector: '[data-command="scan"]'
    }
  ],
  rename: [
    {
      id: 'scan',
      label: '扫描重命名素材',
      description: '读取视频并生成重命名预览',
      selector: '[data-command="scan"]'
    }
  ],
  poster: [
    {
      id: 'scan',
      label: '刷新封面素材',
      description: '扫描视频列表并更新封面状态',
      selector: '[data-command="scan"]'
    }
  ],
  nfo: [
    {
      id: 'scan',
      label: '生成归档计划',
      description: '扫描当前工作区并预览 NFO 归档',
      selector: '[data-command="scan"]'
    }
  ],
  dedupe: [
    {
      id: 'scan',
      label: '开始重复检测',
      description: '计算文件指纹并检测重复视频',
      selector: '[data-command="scan"]'
    }
  ],
  library: [
    {
      id: 'scan',
      label: '刷新媒体库',
      description: '重新扫描视频素材与封面状态',
      selector: '[data-command="scan"]'
    }
  ],
  'comic-merge': [
    {
      id: 'scan',
      label: '刷新漫画列表',
      description: '扫描章节和可追更状态',
      selector: '[data-command="scan"]'
    }
  ],
  'comic-library': [
    {
      id: 'scan',
      label: '刷新数字书架',
      description: '重新扫描已归档漫画',
      selector: '[data-command="scan"]'
    }
  ]
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }): React.JSX.Element {
  const paths: Record<IconName, React.JSX.Element> = {
    archive: (
      <>
        <rect x="3" y="4" width="18" height="5" rx="1" />
        <path d="M5 9v10h14V9M10 13h4" />
      </>
    ),
    book: (
      <>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z" />
        <path d="M4 5.5v16M8 7h8" />
      </>
    ),
    brush: (
      <>
        <path d="m14.5 4.5 5 5M4 20c2.8 0 5-1.5 5-4.5 0-1.2.6-2.2 1.5-3.1L17.7 5a2.1 2.1 0 0 1 3 3l-7.2 7.2C12.6 16.1 11.6 17 10.5 17 7.5 17 6 19.2 6 20z" />
      </>
    ),
    film: (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
        <path d="M7.5 4.5v15M16.5 4.5v15M3.5 9h4M16.5 9h4M3.5 15h4M16.5 15h4" />
        <path d="m10.5 9.2 4.2 2.8-4.2 2.8z" />
      </>
    ),
    folder: (
      <>
        <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </>
    ),
    image: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9" r="1.5" />
        <path d="m21 16-5-5L5 20" />
      </>
    ),
    library: (
      <>
        <path d="M4 4h16v16H4zM8 4v16M12 8h4M12 12h4" />
      </>
    ),
    merge: (
      <>
        <path d="M7 4v4c0 4 3 4 5 4h5M17 8l3 4-3 4M7 20v-4c0-4 3-4 5-4" />
      </>
    ),
    recent: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 7v5l3 2M4 4v4h4" />
      </>
    ),
    rename: (
      <>
        <path d="M4 7V4h3M4 4l6 6M14 5h6v6M20 5l-6 6M4 17v3h3M4 20l6-6M20 17v3h-3M20 20l-6-6" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.3 2.3-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-3v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L6.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H5v-3h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.3-2.3.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V4h3v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v3h-.2a1.7 1.7 0 0 0-1.5 1Z" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" />
      </>
    )
  }
  return (
    <svg className="app-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

/**
 * 任务浮层（进度浮岛 + 任务抽屉）单独挂载并自订阅任务事件：
 * 批量任务期间事件以 120ms 节流高频推送，若由 App 根组件持有状态，
 * 每次事件都会触发全部常驻页面（含数百行的漫画/视频列表）整树重渲染。
 * 独立组件订阅后，事件更新只重渲染浮层自身，页面不受影响。
 */
function TaskLayer(): React.JSX.Element {
  const feed = useTaskFeed()
  const isBusy = feed.activeTasks.length > 0

  // 任务事件只重渲此浮层；根属性让 CSS/Canvas 在重负载期间暂停纯装饰效果。
  useEffect(() => {
    const root = document.documentElement
    if (isBusy) root.dataset.taskBusy = 'true'
    else delete root.dataset.taskBusy
    return () => {
      delete root.dataset.taskBusy
    }
  }, [isBusy])

  return (
    <>
      <TaskIsland feed={feed} />
      <TaskCenter feed={feed} />
    </>
  )
}

function App(): React.JSX.Element {
  // 全局卡片聚光光斑坐标跟踪（Vercel 式 spotlight hover），零渲染开销
  useSpotlightHover()
  // null = 显示模块选择页（首次启动 / 主动返回）
  const [module, setModule] = useState<AppModule | null>(null)
  const [page, setPage] = useState<PageKey>('clean')
  const [workspaces, setWorkspaces] = useState<Record<AppModule, string>>({ video: '', comic: '' })
  const [recents, setRecents] = useState<Record<AppModule, string[]>>({ video: [], comic: [] })
  const [showRecents, setShowRecents] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [appError, setAppError] = useState('')
  const [commandOpen, setCommandOpen] = useState(false)
  const [pendingPosterCount, setPendingPosterCount] = useState(0)
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null)
  const dragDepth = useRef(0)

  const workspace = module ? workspaces[module] : ''
  const moduleRecents = module ? recents[module] : []
  // 启动初始化：应用主题、恢复上次模块与双工作区（media:// 白名单同步注册）、
  // 请求系统通知权限、清理过期播放进度缓存
  useEffect(() => {
    applyPlatformAppearance()
    window.api
      .getSettings()
      .then(async (settings) => {
        // HMR 时预加载层可能暂时保留旧版返回值；缺少新外观字段时使用同平台兜底，避免覆盖主进程默认。
        const appearanceDefaults = getPlatformAppearanceDefaults()
        const backgroundAppearance = settings.backgroundAppearance ?? DEFAULT_BACKGROUND_APPEARANCE
        applyTheme(settings.theme, settings.themePalette, settings.customAccent || '#1687d9')
        applyPerformanceMode(settings.performanceMode ?? appearanceDefaults.performanceMode)
        applyBackgroundAppearance(backgroundAppearance)
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
      .catch((error: unknown) => {
        setAppError(`应用初始化失败：${error instanceof Error ? error.message : String(error)}`)
      })
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
    prunePlayPositions()
  }, [])

  /** 切换模块（运行时灵活切换，双模块页面状态各自保留） */
  const switchModuleNow = useCallback((next: AppModule | null): void => {
    setModule(next)
    setShowRecents(false)
    if (next) setPage(MODULE_META[next].home)
    // null 代表用户主动回到模块选择页，必须持久化，避免下次启动又自动进入旧模块。
    window.api.updateSettings({ activeModule: next }).catch(() => {})
  }, [])

  /** 离开封面页前拦截未落盘的推荐/人工选择，避免候选被误忘。 */
  const requestNavigation = useCallback(
    (action: () => void): void => {
      if (module === 'video' && page === 'poster' && pendingPosterCount > 0) {
        setPendingNavigation(() => action)
        return
      }
      action()
    },
    [module, page, pendingPosterCount]
  )

  const switchModule = useCallback(
    (next: AppModule | null): void => requestNavigation(() => switchModuleNow(next)),
    [requestNavigation, switchModuleNow]
  )

  const navigateToPage = useCallback(
    (next: PageKey): void => requestNavigation(() => setPage(next)),
    [requestNavigation]
  )

  const runCurrentPageAction = useCallback((selector: string): boolean => {
    const activePage = document.querySelector<HTMLElement>('.page-host:not(.page-hidden)')
    const target = activePage?.querySelector<HTMLButtonElement>(selector)
    if (!target || target.disabled) return false
    target.click()
    return true
  }, [])

  useEffect(() => {
    const openOperationTimeline = (): void => {
      navigateToPage('settings')
      window.setTimeout(() => window.dispatchEvent(new Event('settings:safety:open')), 0)
    }
    window.addEventListener('operation-timeline:open', openOperationTimeline)
    return () => window.removeEventListener('operation-timeline:open', openOperationTimeline)
  }, [navigateToPage])

  const discardPendingPostersAndNavigate = useCallback((): void => {
    const action = pendingNavigation
    setPendingNavigation(null)
    setPendingPosterCount(0)
    action?.()
  }, [pendingNavigation])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const hasModifier = event.metaKey || event.ctrlKey
      if (hasModifier && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((open) => !open)
        return
      }
      if (hasModifier && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        const search = document.querySelector<HTMLElement>(
          page === 'settings'
            ? '#settings-search'
            : '#library-search, .comic-search input, .comic-search'
        )
        if (search) {
          search.focus()
        } else {
          setCommandOpen(true)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [page])

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
      } catch (error) {
        setAppError(
          `无法打开工作区“${basenameOf(path)}”：${error instanceof Error ? error.message : String(error)}`
        )
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
          onPendingSaveChange={setPendingPosterCount}
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
    { key: 'settings', element: <SettingsPage active={page === 'settings'} /> }
  ]

  // 模块选择页：启动（未记忆模块）或主动切换时展示
  if (!module) {
    return (
      <div className="module-picker workspace-with-background">
        <a className="skip-link" href="#module-choice">
          跳到模块选择
        </a>
        <div className="module-picker-drag" />
        {/* 终端皮肤装饰层：仅 terminal 色板可见，其余皮肤 display:none */}
        <TerminalAtmosphere />
        <HudCorners size="l" />
        <div className="picker-status" aria-hidden="true">
          <span>MEDIA SCRAPER // LOCAL OPS TERMINAL</span>
          <span>LOCAL-ONLY // NO CLOUD SYNC</span>
        </div>
        <div className="module-picker-intro">
          <div className="module-picker-mark" aria-hidden="true">
            <Icon name="film" size={26} />
          </div>
          <p className="eyebrow">Media Scraper · Local Studio</p>
          <h1>从素材开始，整理你的媒体工作台。</h1>
          <p className="muted">
            选择一间工作室开始处理。视频与漫画各自保留工作区、页面状态与最近记录。
          </p>
        </div>
        <div id="module-choice" className="module-cards">
          {(Object.keys(MODULE_META) as AppModule[]).map((key, index) => (
            <Magnetic key={key}>
              <button
                data-spotlight=""
                className={`module-card module-card-${key}`}
                onClick={() => switchModule(key)}
              >
                <span className="module-card-index" aria-hidden="true">
                  {`${String(index + 1).padStart(2, '0')} //`}
                </span>
                <HudCorners size="s" />
                <span className="module-card-icon">
                  <Icon name={MODULE_META[key].icon} size={38} />
                </span>
                <span className="module-card-kicker">
                  {key === 'video' ? 'VIDEO DESK' : 'COMIC DESK'}
                </span>
                <span className="module-card-name">{MODULE_META[key].name}</span>
                <span className="module-card-desc">
                  {key === 'video'
                    ? '为本地视频完成清理、合并、命名与归档。'
                    : '将章节整理为 EPUB / PDF，并持续增量追更。'}
                </span>
                <span className="module-card-capabilities" aria-hidden="true">
                  {key === 'video'
                    ? '清理 · 合并 · 重命名 · 归档'
                    : '章节合并 · EPUB / PDF · 漫画库'}
                </span>
                <span className="module-card-enter">
                  进入{MODULE_META[key].name} <span aria-hidden="true">→</span>
                </span>
              </button>
            </Magnetic>
          ))}
        </div>
        <p className="picker-bootline" aria-hidden="true">
          VIDEO DESK · COMIC DESK — ALL PROCESSING LOCAL
        </p>
        <CursorTrail />
      </div>
    )
  }

  const navItems = module === 'video' ? VIDEO_NAV_ITEMS : COMIC_NAV_ITEMS

  return (
    <div
      className="app-shell workspace-with-background"
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
            aria-label="切换模块"
            onClick={() => switchModule(null)}
          >
            <span className={`brand-icon brand-icon-${module}`}>
              <Icon name={MODULE_META[module].icon} size={28} />
            </span>
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
              aria-label="显示最近工作区"
              aria-expanded={showRecents}
              onClick={() => setShowRecents((v) => !v)}
            >
              <Icon name="recent" size={15} /> 最近
            </button>
          )}
          {showRecents && moduleRecents.length > 0 && (
            <>
              <button
                className="recents-mask"
                type="button"
                aria-label="关闭最近工作区列表"
                onClick={() => setShowRecents(false)}
              />
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
          {navItems.map((item, index) => (
            <button
              key={item.key}
              data-spotlight=""
              className={`nav-item ${page === item.key ? 'active' : ''}`}
              aria-current={page === item.key ? 'page' : undefined}
              onClick={() => navigateToPage(item.key)}
            >
              {/* 终端皮肤显示序号，其余皮肤隐藏 */}
              <span className="nav-index" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="nav-icon">
                <Icon name={item.icon} />
              </span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">v1.4.0 · 本地处理，隐私安全</div>
      </aside>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <main id="main-content" className="content" tabIndex={-1}>
        {appError && <ErrorBanner message={appError} />}
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
      <TaskLayer />
      <CursorTrail />
      <AppToaster />
      {pendingNavigation && (
        <ConfirmDialog
          title="还有封面未保存"
          deleteCount={0}
          deleteBytes={0}
          danger={false}
          ackLabel="我知道这些封面选择尚未保存"
          cancelLabel="返回继续保存"
          confirmLabel="不保存并离开"
          extra={`已有 ${pendingPosterCount} 个视频选中了候选封面。返回封面页后可使用顶部的「确认封面」保存；若直接离开，这些选择会保留在当前会话中，但关闭应用后不会保留。`}
          onConfirm={discardPendingPostersAndNavigate}
          onCancel={() => setPendingNavigation(null)}
        />
      )}
      <CommandPalette
        open={commandOpen}
        module={module}
        videoItems={VIDEO_NAV_ITEMS}
        comicItems={COMIC_NAV_ITEMS}
        onClose={() => setCommandOpen(false)}
        onNavigate={navigateToPage}
        onSwitchModule={switchModule}
        onChooseWorkspace={() => void chooseWorkspace()}
        onFocusSearch={() =>
          document
            .querySelector<HTMLElement>('#library-search, .comic-search input, .comic-search')
            ?.focus()
        }
        pageActions={PAGE_COMMAND_ACTIONS[page] ?? []}
        onRunPageAction={runCurrentPageAction}
      />
    </div>
  )
}

export default App
