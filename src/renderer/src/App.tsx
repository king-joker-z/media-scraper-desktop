import { useCallback, useState } from 'react'
import CleanPage from './pages/CleanPage'
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

export type PageKey =
  'clean' | 'merge' | 'rename' | 'poster' | 'nfo' | 'dedupe' | 'library' | 'settings'

const NAV_ITEMS: { key: PageKey; icon: string; label: string }[] = [
  { key: 'clean', icon: '🧹', label: '目录清理' },
  { key: 'merge', icon: '🎬', label: '视频合并' },
  { key: 'rename', icon: '✏️', label: '批量重命名' },
  { key: 'poster', icon: '🖼️', label: '封面管理' },
  { key: 'nfo', icon: '📦', label: 'NFO 归档' },
  { key: 'dedupe', icon: '🧬', label: '视频去重' },
  { key: 'library', icon: '📺', label: '媒体库' },
  { key: 'settings', icon: '⚙️', label: '设置' }
]

const basenameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function App(): React.JSX.Element {
  const [page, setPage] = useState<PageKey>('clean')
  const [workspace, setWorkspace] = useState('')

  const chooseWorkspace = useCallback(async (): Promise<void> => {
    const selected = await window.api.selectWorkspace()
    if (selected) setWorkspace(selected)
  }, [])

  // 所有模块页面常驻挂载：切换只隐藏不卸载，扫描结果/报告等状态完整保留；
  // 页面重新可见时由 useWorkspaceSync 对比工作区指纹决定是否自动重扫。
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
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-drag" />
        <div className="sidebar-brand">
          <span className="brand-icon">🎞️</span>
          <span className="brand-name">Media Scraper</span>
        </div>
        <button className="workspace-button" onClick={chooseWorkspace} title={workspace}>
          <span className="workspace-label">工作区</span>
          <span className="workspace-value">
            {workspace ? basenameOf(workspace) : '点击选择文件夹'}
          </span>
        </button>
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
        <div className="sidebar-footer">v1.0.0 · 本地处理，隐私安全</div>
      </aside>
      <main className="content">
        {modulePages.map((item) => (
          <div key={item.key} className={`page-host ${page === item.key ? '' : 'page-hidden'}`}>
            <ErrorBoundary>{item.element}</ErrorBoundary>
          </div>
        ))}
      </main>
      <TaskProgress />
      <TaskCenter />
    </div>
  )
}

export default App
