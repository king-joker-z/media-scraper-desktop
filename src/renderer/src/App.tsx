import { useCallback, useEffect, useRef, useState } from 'react'
import CleanPage from './pages/CleanPage'
import DedupePage from './pages/DedupePage'
import HealthPage from './pages/HealthPage'
import LibraryPage from './pages/LibraryPage'
import MergePage from './pages/MergePage'
import NfoPage from './pages/NfoPage'
import PipelinePage from './pages/PipelinePage'
import PosterPage from './pages/PosterPage'
import RenamePage from './pages/RenamePage'
import SettingsPage from './pages/SettingsPage'
import TaskCenter from './components/TaskCenter'
import TaskProgress from './components/TaskProgress'
import ErrorBoundary from './components/ErrorBoundary'
import { prunePlayPositions } from './utils/media'
import { applyTheme } from './utils/theme'

export type PageKey =
  'clean' | 'merge' | 'rename' | 'poster' | 'nfo' | 'pipeline' | 'dedupe' | 'health' | 'library' | 'settings'

const NAV_ITEMS: { key: PageKey; icon: string; label: string }[] = [
  { key: 'clean', icon: '🧹', label: '目录清理' },
  { key: 'merge', icon: '🎬', label: '视频合并' },
  { key: 'rename', icon: '✏️', label: '批量重命名' },
  { key: 'poster', icon: '🖼️', label: '封面管理' },
  { key: 'nfo', icon: '📦', label: 'NFO 归档' },
  { key: 'pipeline', icon: '🔗', label: '流水线' },
  { key: 'dedupe', icon: '🧬', label: '视频去重' },
  { key: 'health', icon: '🩺', label: '健康体检' },
  { key: 'library', icon: '📺', label: '媒体库' },
  { key: 'settings', icon: '⚙️', label: '设置' }
]

const basenameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function App(): React.JSX.Element {
  const [page, setPage] = useState<PageKey>('clean')
  const [workspace, setWorkspace] = useState('')
  const [recents, setRecents] = useState<string[]>([])
  const [showRecents, setShowRecents] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const dragDepth = useRef(0)

  const refreshRecents = useCallback((): void => {
    window.api
      .getSettings()
      .then((settings) => setRecents(settings.recentWorkspaces))
      .catch(() => {})
  }, [])

  // 启动初始化：应用主题、恢复上次工作区（media:// 白名单同步注册）、
  // 请求系统通知权限、清理过期播放进度缓存
  useEffect(() => {
    window.api
      .getSettings()
      .then(async (settings) => {
        applyTheme(settings.theme)
        setRecents(settings.recentWorkspaces)
        const last = settings.recentWorkspaces[0]
        if (last) {
          const valid = await window.api.useWorkspace(last).catch(() => null)
          if (valid) setWorkspace(valid)
        }
      })
      .catch(() => {})
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
    prunePlayPositions()
  }, [])

  const chooseWorkspace = useCallback(async (): Promise<void> => {
    const selected = await window.api.selectWorkspace()
    if (selected) {
      setWorkspace(selected)
      refreshRecents()
    }
  }, [refreshRecents])

  // 命名不能以 use 开头，否则会被 react-hooks 规则误判为 Hook
  const openWorkspace = useCallback(
    async (path: string): Promise<void> => {
      try {
        const valid = await window.api.useWorkspace(path)
        setWorkspace(valid)
        refreshRecents()
      } catch {
        // 无效目录（不存在/不可读）忽略
      }
    },
    [refreshRecents]
  )

  // 拖拽文件夹到窗口任意位置即可设为工作区（Electron 39 需经 webUtils 取路径）
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
          active={page === 'clean'}
          workspace={workspace}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'merge',
      element: (
        <MergePage
          active={page === 'merge'}
          workspace={workspace}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'rename',
      element: (
        <RenamePage
          active={page === 'rename'}
          workspace={workspace}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'poster',
      element: (
        <PosterPage
          active={page === 'poster'}
          workspace={workspace}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'nfo',
      element: (
        <NfoPage
          active={page === 'nfo'}
          workspace={workspace}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'pipeline',
      element: (
        <PipelinePage
          active={page === 'pipeline'}
          workspace={workspace}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'dedupe',
      element: (
        <DedupePage
          active={page === 'dedupe'}
          workspace={workspace}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'health',
      element: (
        <HealthPage
          active={page === 'health'}
          workspace={workspace}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    {
      key: 'library',
      element: (
        <LibraryPage
          active={page === 'library'}
          workspace={workspace}
          onChooseWorkspace={chooseWorkspace}
        />
      )
    },
    { key: 'settings', element: <SettingsPage /> }
  ]

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
          <span className="brand-icon">🎞️</span>
          <span className="brand-name">Media Scraper</span>
        </div>
        <div className="workspace-host">
          <button className="workspace-button" onClick={chooseWorkspace} title={workspace}>
            <span className="workspace-label">工作区</span>
            <span className="workspace-value">
              {workspace ? basenameOf(workspace) : '点击选择 / 拖入文件夹'}
            </span>
          </button>
          {recents.length > 0 && (
            <button
              className="recents-toggle"
              title="最近使用的工作区"
              onClick={() => setShowRecents((v) => !v)}
            >
              🕘 最近
            </button>
          )}
          {showRecents && recents.length > 0 && (
            <>
              <div className="recents-mask" onClick={() => setShowRecents(false)} />
              <div className="recents-pop">
                {recents.map((path) => (
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
          {NAV_ITEMS.map((item) => (
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
        <div className="sidebar-footer">v1.1.0 · 本地处理，隐私安全</div>
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
          <div className="drop-hint">松开以设为工作区</div>
        </div>
      )}
      <TaskProgress />
      <TaskCenter />
    </div>
  )
}

export default App
