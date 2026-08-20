import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppModule } from '../../../shared/types'
import type { PageKey } from '../App'

type Command = {
  id: string
  label: string
  description: string
  group: string
  shortcut?: string
  disabled?: boolean
  run: () => boolean | void
}

type PageAction = {
  id: string
  label: string
  description: string
  selector: string
}

type NavigationItem = { key: PageKey; label: string }

function CommandPalette({
  open,
  module,
  videoItems,
  comicItems,
  onClose,
  onNavigate,
  onSwitchModule,
  onChooseWorkspace,
  onFocusSearch,
  pageActions,
  onRunPageAction
}: {
  open: boolean
  module: AppModule | null
  videoItems: NavigationItem[]
  comicItems: NavigationItem[]
  onClose: () => void
  onNavigate: (page: PageKey) => void
  onSwitchModule: (module: AppModule) => void
  onChooseWorkspace: () => void
  onFocusSearch: () => void
  pageActions: PageAction[]
  onRunPageAction: (selector: string) => boolean
}): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const commands = useMemo<Command[]>(() => {
    const navigation = (module === 'comic' ? comicItems : videoItems).map((item) => ({
      id: `navigate-${item.key}`,
      label: `前往${item.label}`,
      description: '切换当前工作台页面',
      group: '导航',
      run: () => onNavigate(item.key)
    }))
    const contextualActions = pageActions.map((action) => ({
      id: `page-action-${action.id}`,
      label: action.label,
      description: action.description,
      group: '当前页面',
      run: () => onRunPageAction(action.selector)
    }))
    return [
      ...contextualActions,
      ...navigation,
      {
        id: 'switch-video',
        label: '切换到视频工坊',
        description: '打开视频整理、合并与媒体库',
        group: '工作台',
        run: () => onSwitchModule('video')
      },
      {
        id: 'switch-comic',
        label: '切换到漫画书房',
        description: '打开漫画合并与数字书架',
        group: '工作台',
        run: () => onSwitchModule('comic')
      },
      {
        id: 'choose-workspace',
        label: '选择工作区',
        description: '选择或替换当前模块的素材目录',
        group: '操作',
        run: onChooseWorkspace
      },
      {
        id: 'focus-search',
        label: '搜索当前页面内容',
        description: '定位当前页面的搜索框',
        group: '操作',
        shortcut: '⌘ F',
        run: onFocusSearch
      }
    ]
  }, [
    comicItems,
    module,
    onChooseWorkspace,
    onFocusSearch,
    onNavigate,
    onRunPageAction,
    onSwitchModule,
    pageActions,
    videoItems
  ])

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return commands
    return commands.filter((command) =>
      `${command.label} ${command.description} ${command.group}`.toLowerCase().includes(normalized)
    )
  }, [commands, query])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => previousFocusRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((index) =>
          visible.length === 0 ? 0 : Math.min(index + 1, visible.length - 1)
        )
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((index) => (visible.length === 0 ? 0 : Math.max(index - 1, 0)))
      }
      const selected = visible[Math.min(activeIndex, Math.max(0, visible.length - 1))]
      if (event.key === 'Enter' && selected && !selected.disabled) {
        event.preventDefault()
        if (selected.run() !== false) onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeIndex, onClose, open, visible])

  if (!open) return null

  const execute = (command: Command): void => {
    if (command.disabled) return
    if (command.run() !== false) onClose()
  }

  return (
    <div className="command-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-search-row">
          <span aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            placeholder="搜索命令、页面或工作台…"
            aria-label="搜索命令"
            autoComplete="off"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-heading">
          <div>
            <p id="command-palette-title">快速命令</p>
            <span>用方向键选择，按 Enter 执行</span>
          </div>
          <kbd>⌘ K</kbd>
        </div>
        <div className="command-list" role="listbox" aria-label="可执行命令">
          {visible.length === 0 ? (
            <p className="command-empty">没有匹配的命令，试试“媒体库”或“选择工作区”。</p>
          ) : (
            visible.map((command, index) => (
              <button
                key={command.id}
                className={`command-item ${index === activeIndex ? 'active' : ''}`}
                role="option"
                aria-selected={index === activeIndex}
                disabled={command.disabled}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => execute(command)}
              >
                <span className="command-item-copy">
                  <b>{command.label}</b>
                  <small>{command.description}</small>
                </span>
                <span className="command-item-meta">{command.shortcut ?? command.group}</span>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

export default CommandPalette
