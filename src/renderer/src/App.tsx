import { useCallback, useState } from 'react'
import CleanPage from './pages/CleanPage'
import PlaceholderPage from './pages/PlaceholderPage'
import SettingsPage from './pages/SettingsPage'
import TaskCenter from './components/TaskCenter'

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
          <PlaceholderPage
            icon="🎬"
            title="视频物理合并"
            milestone="M4"
            points={[
              '缩略图列表：标题 / 大小 / 时长 / 分辨率 / 方向 / 编码',
              '全合并 · 横屏合并 · 竖屏合并 · 自由组合（拖拽排序）',
              '兼容素材无重编码秒级拼接，不兼容自动转码统一',
              '合并校验通过后才会列出源片段删除清单'
            ]}
          />
        )
      case 'rename':
        return (
          <PlaceholderPage
            icon="✏️"
            title="批量重命名"
            milestone="M3"
            points={[
              '纯序号：标题/大小排序、升降序、位数与分隔符可设',
              '正则清洗 + 序号：内置常用模板，支持自定义保存',
              'AI 重命名：OpenRouter 模型，prompt 模板变量可配',
              '视频与 poster 成组改名，预览可编辑、冲突标红'
            ]}
          />
        )
      case 'poster':
        return (
          <PlaceholderPage
            icon="🖼️"
            title="Poster 封面管理"
            milestone="M2"
            points={[
              '无 poster 视频默认截取 5 张候选（10/30/50/70/90%）',
              '详情页播放视频、拖动时间轴、任意时点截图',
              '保存唯一封面为 <视频名>-poster.jpg',
              '落选候选与旧图进入删除清单，确认后清理'
            ]}
          />
        )
      case 'nfo':
        return (
          <PlaceholderPage
            icon="📦"
            title="NFO 与独立归档"
            milestone="M3"
            points={[
              '每个视频建立同名文件夹，视频 + poster + NFO 归入',
              'NFO 兼容 Kodi / Jellyfin / Emby，纯本地不联网',
              'actor 默认取工作区文件夹名，可指定覆盖',
              '生成后自动校验 XML 与文件关系'
            ]}
          />
        )
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
      <main className="content">{renderPage()}</main>
      <TaskCenter />
    </div>
  )
}

export default App
