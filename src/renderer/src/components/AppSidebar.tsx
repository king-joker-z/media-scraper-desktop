import type { AppModule } from '../../../shared/types'
import { basenameOf } from '../utils/format'
import { usePalette } from '../hooks/usePalette'
import type { PageKey } from '../App'

export type IconName =
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

export interface NavItemDef {
  key: PageKey
  icon: IconName
  label: string
}

export function AppIcon({ name, size = 18 }: { name: IconName; size?: number }): React.JSX.Element {
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
 * 侧边导航外壳：按主题渲染完全不同的布局骨架。
 * - terminal: 战术面板、带呼号/状态指示灯、网格切角、mono 频道行
 * - comic: 漫画书脊、黑框白底、对话气泡风格的切模块、斜切粗体按钮
 * - comic-ukiyo: 日式立轴、朱印铭牌、和纸质感、竖排朱墨色系
 * - default: 经典磨砂玻璃侧边栏
 */
export function AppSidebar({
  module,
  page,
  workspace,
  recents,
  showRecents,
  navItems,
  onSwitchModule,
  onChooseWorkspace,
  onOpenWorkspace,
  onToggleRecents,
  onCloseRecents,
  onNavigate
}: {
  module: AppModule
  page: PageKey
  workspace: string
  recents: string[]
  showRecents: boolean
  navItems: NavItemDef[]
  onSwitchModule: () => void
  onChooseWorkspace: () => void
  onOpenWorkspace: (path: string) => void
  onToggleRecents: () => void
  onCloseRecents: () => void
  onNavigate: (key: PageKey) => void
}): React.JSX.Element {
  const palette = usePalette()
  const moduleName = module === 'video' ? '视频工坊' : '漫画书房'
  const moduleIcon: IconName = module === 'video' ? 'film' : 'book'

  /* -------------------- 作战终端皮肤 -------------------- */
  if (palette === 'terminal') {
    return (
      <aside className="sidebar sidebar-terminal">
        <div className="sidebar-drag" />
        <div className="sb-term-top">
          <div className="sb-term-status">
            <span className="sb-term-led" aria-hidden="true" />
            <span className="sb-term-callsign">NODE // {module.toUpperCase()}</span>
            <span className="sb-term-sec">ONLINE</span>
          </div>
          <button
            className="sb-term-switch"
            title="切换作战单元（视频 / 漫画）"
            onClick={onSwitchModule}
          >
            <span className="sb-term-icon">
              <AppIcon name={moduleIcon} size={20} />
            </span>
            <b className="sb-term-name">{moduleName}</b>
            <span className="sb-term-caret">⇄</span>
          </button>
        </div>

        <div className="workspace-host sb-term-ws">
          <button className="workspace-button" onClick={onChooseWorkspace} title={workspace}>
            <span className="workspace-label">
              MOUNT // {module === 'video' ? 'VIDEO' : 'COMIC'}
            </span>
            <span className="workspace-value">
              {workspace ? basenameOf(workspace) : 'SELECT / DROP DIR'}
            </span>
          </button>
          {recents.length > 0 && (
            <button
              className="recents-toggle"
              title="历史挂载点"
              aria-expanded={showRecents}
              onClick={onToggleRecents}
            >
              <AppIcon name="recent" size={13} /> HIST
            </button>
          )}
          {showRecents && recents.length > 0 && (
            <>
              <button
                className="recents-mask"
                type="button"
                aria-label="关闭历史列表"
                onClick={onCloseRecents}
              />
              <div className="recents-pop sb-term-recents">
                {recents.map((path) => (
                  <button
                    key={path}
                    className={`recents-item ${path === workspace ? 'active' : ''}`}
                    title={path}
                    onClick={() => {
                      onCloseRecents()
                      onOpenWorkspace(path)
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

        <nav className="sidebar-nav sb-term-nav">
          <div className="sb-term-nav-head">CHANNELS</div>
          {navItems.map((item, index) => (
            <button
              key={item.key}
              data-spotlight=""
              className={`nav-item sb-term-item ${page === item.key ? 'active' : ''}`}
              aria-current={page === item.key ? 'page' : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <span className="nav-index" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="nav-icon">
                <AppIcon name={item.icon} />
              </span>
              <span className="nav-label">{item.label}</span>
              {page === item.key && (
                <span className="sb-term-reticle" aria-hidden="true">
                  ◀
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer sb-term-footer">
          <span>SYS.VER 1.5.0</span>
          <span>AIR-GAPPED</span>
        </div>
      </aside>
    )
  }

  /* -------------------- 漫画风皮肤 -------------------- */
  if (palette === 'comic') {
    return (
      <aside className="sidebar sidebar-comic">
        <div className="sidebar-drag" />
        <div className="sb-comic-spine">
          <div className="sb-comic-badge">
            <span className="sb-comic-vol">VOL.01</span>
            <span className="sb-comic-burst" aria-hidden="true">
              ★
            </span>
          </div>
          <button
            className="sb-comic-switch"
            title="切换分册（视频 / 漫画）"
            onClick={onSwitchModule}
          >
            <span className="sb-comic-icon">
              <AppIcon name={moduleIcon} size={24} />
            </span>
            <b className="sb-comic-name">{moduleName}</b>
            <span className="sb-comic-caret">切换！</span>
          </button>
        </div>

        <div className="workspace-host sb-comic-ws">
          <button className="workspace-button" onClick={onChooseWorkspace} title={workspace}>
            <span className="workspace-label">
              {module === 'video' ? '当前视频库' : '当前漫画库'}
            </span>
            <span className="workspace-value">
              {workspace ? basenameOf(workspace) : '点击选择文件夹'}
            </span>
          </button>
          {recents.length > 0 && (
            <button
              className="recents-toggle"
              title="最近打开"
              aria-expanded={showRecents}
              onClick={onToggleRecents}
            >
              <AppIcon name="recent" size={14} /> 历史
            </button>
          )}
          {showRecents && recents.length > 0 && (
            <>
              <button
                className="recents-mask"
                type="button"
                aria-label="关闭历史"
                onClick={onCloseRecents}
              />
              <div className="recents-pop sb-comic-recents">
                {recents.map((path) => (
                  <button
                    key={path}
                    className={`recents-item ${path === workspace ? 'active' : ''}`}
                    title={path}
                    onClick={() => {
                      onCloseRecents()
                      onOpenWorkspace(path)
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

        <nav className="sidebar-nav sb-comic-nav">
          <div className="sb-comic-nav-title">目录 CHAPTERS</div>
          {navItems.map((item, index) => (
            <button
              key={item.key}
              data-spotlight=""
              className={`nav-item sb-comic-item ${page === item.key ? 'active' : ''}`}
              aria-current={page === item.key ? 'page' : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <span className="sb-comic-num">#{index + 1}</span>
              <span className="nav-icon">
                <AppIcon name={item.icon} />
              </span>
              <span className="nav-label">{item.label}</span>
              {page === item.key && (
                <span className="sb-comic-star" aria-hidden="true">
                  👈
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer sb-comic-footer">
          <span>连载中 · 本地纯净</span>
        </div>
      </aside>
    )
  }

  /* -------------------- 浮世绘卷皮肤 -------------------- */
  if (palette === 'comic-ukiyo') {
    return (
      <aside className="sidebar sidebar-ukiyo">
        <div className="sidebar-drag" />
        <div className="sb-ukiyo-crest">
          <div className="sb-ukiyo-stamp">
            <span className="sb-ukiyo-seal-char">卷</span>
          </div>
          <button
            className="sb-ukiyo-switch"
            title="切换卷册（视频 / 漫画）"
            onClick={onSwitchModule}
          >
            <span className="sb-ukiyo-icon">
              <AppIcon name={moduleIcon} size={22} />
            </span>
            <b className="sb-ukiyo-name">{moduleName}</b>
            <span className="sb-ukiyo-caret">撰</span>
          </button>
        </div>

        <div className="workspace-host sb-ukiyo-ws">
          <button className="workspace-button" onClick={onChooseWorkspace} title={workspace}>
            <span className="workspace-label">{module === 'video' ? '藏影阁' : '藏画阁'}</span>
            <span className="workspace-value">
              {workspace ? basenameOf(workspace) : '点选工作区'}
            </span>
          </button>
          {recents.length > 0 && (
            <button
              className="recents-toggle"
              title="往昔工作区"
              aria-expanded={showRecents}
              onClick={onToggleRecents}
            >
              <AppIcon name="recent" size={14} /> 往昔
            </button>
          )}
          {showRecents && recents.length > 0 && (
            <>
              <button
                className="recents-mask"
                type="button"
                aria-label="关闭往昔"
                onClick={onCloseRecents}
              />
              <div className="recents-pop sb-ukiyo-recents">
                {recents.map((path) => (
                  <button
                    key={path}
                    className={`recents-item ${path === workspace ? 'active' : ''}`}
                    title={path}
                    onClick={() => {
                      onCloseRecents()
                      onOpenWorkspace(path)
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

        <nav className="sidebar-nav sb-ukiyo-nav">
          <div className="sb-ukiyo-nav-title">目次 · INDEX</div>
          {navItems.map((item, index) => (
            <button
              key={item.key}
              data-spotlight=""
              className={`nav-item sb-ukiyo-item ${page === item.key ? 'active' : ''}`}
              aria-current={page === item.key ? 'page' : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <span className="sb-ukiyo-idx">{index + 1}</span>
              <span className="nav-icon">
                <AppIcon name={item.icon} />
              </span>
              <span className="nav-label">{item.label}</span>
              {page === item.key && <span className="sb-ukiyo-dot" aria-hidden="true" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer sb-ukiyo-footer">
          <span>全编完 · 私室静鉴</span>
        </div>
      </aside>
    )
  }

  /* -------------------- 默认皮肤 -------------------- */
  return (
    <aside className="sidebar">
      <div className="sidebar-drag" />
      <div className="sidebar-brand">
        <button
          className="module-switch"
          title="切换模块（视频 / 漫画）"
          aria-label="切换模块"
          onClick={onSwitchModule}
        >
          <span className={`brand-icon brand-icon-${module}`}>
            <AppIcon name={moduleIcon} size={28} />
          </span>
          <span className="brand-name">{moduleName}</span>
          <span className="module-switch-caret">⇄</span>
        </button>
      </div>
      <div className="workspace-host">
        <button className="workspace-button" onClick={onChooseWorkspace} title={workspace}>
          <span className="workspace-label">{module === 'video' ? '工作区' : '漫画工作区'}</span>
          <span className="workspace-value">
            {workspace ? basenameOf(workspace) : '点击选择 / 拖入文件夹'}
          </span>
        </button>
        {recents.length > 0 && (
          <button
            className="recents-toggle"
            title="最近使用的工作区"
            aria-label="显示最近工作区"
            aria-expanded={showRecents}
            onClick={onToggleRecents}
          >
            <AppIcon name="recent" size={15} /> 最近
          </button>
        )}
        {showRecents && recents.length > 0 && (
          <>
            <button
              className="recents-mask"
              type="button"
              aria-label="关闭最近工作区列表"
              onClick={onCloseRecents}
            />
            <div className="recents-pop">
              {recents.map((path) => (
                <button
                  key={path}
                  className={`recents-item ${path === workspace ? 'active' : ''}`}
                  title={path}
                  onClick={() => {
                    onCloseRecents()
                    onOpenWorkspace(path)
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
            onClick={() => onNavigate(item.key)}
          >
            <span className="nav-index" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="nav-icon">
              <AppIcon name={item.icon} />
            </span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">v1.5.0 · 本地处理，隐私安全</div>
    </aside>
  )
}
