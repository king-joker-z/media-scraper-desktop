import { useCallback, useState } from 'react'
import CleanPage from './pages/CleanPage'
import MergePage from './pages/MergePage'
import NfoPage from './pages/NfoPage'
import PosterPage from './pages/PosterPage'
import RenamePage from './pages/RenamePage'
import SettingsPage from './pages/SettingsPage'
import TaskCenter from './components/TaskCenter'
import TaskProgress from './components/TaskProgress'
import ErrorBoundary from './components/ErrorBoundary'

export type PageKey = 'clean' | 'merge' | 'rename' | 'poster' | 'nfo' | 'settings'

const NAV_ITEMS: { key: PageKey; icon: string; label: string }[] = [
  { key: 'clean', icon: '🧹', label: '目录清理' },
  { key: 'merge', icon: '🎬', label: '视频合并' },
  { key: 'rename', icon: '✏️', label: '批量重命名' },
  { key: 'poster', icon: '🖼️', label: '封面管理' },
  { key: 'nfo', icon: '📦', label: 'NFO 归档' },
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

  const renderPage = (): React.JSX.Element => {
    switch (page) {
      case 'clean':
        return <CleanPage workspace={workspace} onChooseWorkspace={chooseWorkspace} />
      case 'merge':
        return (
          <MergePage key={workspace} workspace={workspace} onChooseWorkspace={chooseWorkspace} />
        )
      case 'rename':
        return (
          <RenamePage key={workspace} workspace={workspace} onChooseWorkspace={chooseWorkspace} />
        )
      case 'poster':
        // key 随工作区变化：切换工作区时整体重置页面状态
        return (
          <PosterPage key={workspace} workspace={workspace} onChooseWorkspace={chooseWorkspace} />
        )
      case 'nfo':
        return <NfoPage key={workspace} workspace={workspace} onChooseWorkspace={chooseWorkspace} />
      case 'settings':
        return <SettingsPage />
    }
  }

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
        <ErrorBoundary>{renderPage()}</ErrorBoundary>
      </main>
      <TaskProgress />
      <TaskCenter />
    </div>
  )
}

export default App
