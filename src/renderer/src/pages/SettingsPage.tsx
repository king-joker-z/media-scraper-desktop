import { HexColorInput, HexColorPicker } from 'react-colorful'
import { useEffect, useRef, useState } from 'react'
import type {
  AiProviderConfig,
  AppSettings,
  BackgroundAppearance,
  CursorEffectsMode,
  PerformanceDiagnostics,
  StorageCategory,
  StorageStats,
  ThemeMode,
  ThemePalette
} from '../../../shared/types'
import OperationTimeline from '../components/OperationTimeline'
import { formatBytes } from '../utils/format'
import {
  applyBackgroundAppearance,
  applyPerformanceMode,
  applyTheme,
  DEFAULT_BACKGROUND_APPEARANCE
} from '../utils/theme'
import { getPlatformAppearanceDefaults } from '../utils/appearance-defaults'
import { mediaUrl } from '../utils/media'

const BUILT_IN_PROVIDER_IDS = new Set([
  'openrouter',
  'deepseek',
  'aicodemirror',
  'linkai',
  'acucompute'
])

const AI_PROTOCOL_OPTIONS = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions 兼容' },
  { value: 'openai-responses', label: 'OpenAI Responses / Codex 兼容' },
  { value: 'anthropic-messages', label: 'Anthropic Messages 原生' },
  { value: 'gemini-generate-content', label: 'Google Gemini 原生' }
] as const

const THEME_TABS: { key: ThemeMode; label: string }[] = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' }
]

const CURSOR_EFFECT_TABS: { key: CursorEffectsMode; label: string; description: string }[] = [
  { key: 'particles', label: '粒子光点', description: '轻盈惯性尾迹' },
  { key: 'ribbon', label: '霓虹拖尾', description: '流动线条笔触' },
  { key: 'sparkles', label: '星尘闪烁', description: '会呼吸的小星芒' },
  { key: 'comets', label: '流星彗尾', description: '高速划过的光束' },
  { key: 'confetti', label: '彩纸碎屑', description: '主题色纸片飘落' },
  { key: 'ripples', label: '水波涟漪', description: '点击扩散的圆环' },
  { key: 'off', label: '关闭动效', description: '不显示任何轨迹' }
]

const PALETTE_OPTIONS: { key: ThemePalette; label: string; description: string }[] = [
  { key: 'ocean', label: '海洋蓝', description: '专注、清晰，适合日常整理' },
  { key: 'violet', label: '暮光紫', description: '更具创作感的深邃强调色' },
  { key: 'forest', label: '森林绿', description: '低干扰、舒缓的任务氛围' },
  { key: 'sunset', label: '日落橙', description: '鲜明温暖，突出操作反馈' },
  { key: 'graphite', label: '石墨灰', description: '低饱和中性，适合长时间专注' },
  { key: 'berry', label: '莓果红', description: '克制鲜明，适合重点操作提示' },
  { key: 'amber', label: '琥珀金', description: '沉稳明亮，兼顾辨识与温度' },
  { key: 'jade', label: '青瓷色', description: '清爽平衡，降低视觉疲劳' },
  { key: 'sky', label: '晴空蓝', description: '通透明快，适合长时间浏览素材' },
  { key: 'mint', label: '薄荷绿', description: '轻盈干净，营造舒展的工作节奏' },
  { key: 'lemon', label: '柠檬黄', description: '明亮活泼，让关键操作更易发现' },
  { key: 'rose', label: '樱花粉', description: '柔和轻快，为界面增添温暖层次' },
  { key: 'comic', label: '漫画风', description: '墨线、纸张与亮黄点缀，侧栏同步切换' },
  { key: 'comic-ukiyo', label: '浮世绘卷', description: '青海波纹、靛蓝朱印与木刻版画框' },
  { key: 'pixel', label: '像素风', description: '8-bit 机能配色与像素化游戏界面质感' },
  { key: 'retro', label: '复古未来', description: '铬金属、太空轨道与复古仪表盘质感' },
  { key: 'editorial', label: '编辑风', description: '报纸分栏、衬线大标题与印刷油墨质感' },
  { key: 'glass', label: '液态玻璃', description: '半透明流光、柔和景深与现代科技质感' },
  { key: 'y2k', label: 'Y2K', description: '糖果金属、梦幻渐变与千禧社交潮流氛围' },
  { key: 'doodle', label: '手绘涂鸦', description: '活泼笔触、纸张质感与内容互动氛围' },
  { key: 'aero', label: 'Frutiger Aero', description: '晴空草地、水润高光与明亮治愈气息' },
  { key: 'swiss', label: '瑞士国际主义', description: '理性网格、红黑高对比与现代主义秩序' },
  { key: 'clay', label: '黏土拟态', description: '柔软体块、温和阴影与触感化界面层次' },
  { key: 'paper', label: '纸艺拼贴', description: '层叠色纸、裁切边缘与手作拼贴质感' },
  { key: 'industrial', label: '工业控制台', description: '高密度仪表、警示色与专业控制面板' },
  { key: 'nordic', label: '北欧自然风', description: '苔藓绿、暖木色与舒展的有机留白' },
  { key: 'mecha', label: '机甲蓝图风', description: '工程蓝图、结构标线与机甲信息层级' },
  { key: 'nautical', label: '航海地图', description: '羊皮纸、海图经纬线与深海罗盘色彩' },
  { key: 'ink', label: '水墨国风', description: '宣纸留白、墨色晕染与朱砂点睛' }
]

const CUSTOM_PALETTE: { key: ThemePalette; label: string; description: string } = {
  key: 'custom',
  label: '自定义强调色',
  description: '可用跨平台色轮实时预览'
}

type SettingsGroup = {
  id: string
  label: string
  description: string
  keywords: string[]
}

const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: 'appearance',
    label: '外观',
    description: '主题、强调色、工作台背景与光标动效',
    keywords: [
      '主题',
      '外观',
      '背景',
      '颜色',
      '色板',
      '磨砂',
      '图片',
      '光标',
      '鼠标',
      '动效',
      '轨迹'
    ]
  },
  {
    id: 'ai',
    label: 'AI 命名',
    description: '平台、模型与 Prompt 模板',
    keywords: ['ai', 'token', '模型', '命名', 'prompt', '平台', 'api']
  },
  {
    id: 'performance',
    label: '性能与合并',
    description: '并发、GPU 加速与临时目录',
    keywords: ['性能', '并发', '扫描', 'ffmpeg', '转码', 'gpu', 'nvenc', 'cuda', '临时']
  },
  {
    id: 'safety',
    label: '安全与记录',
    description: '删除方式、缓存与操作日志',
    keywords: ['删除', '回收站', '安全', '存储', '缓存', '日志', '撤销']
  }
]

function SettingsPage({ active }: { active: boolean }): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  // 色彩选择器使用本地值驱动，防止异步 settings IPC 回包短暂覆盖刚选中的颜色。
  const [customAccent, setCustomAccent] = useState('#1687d9')
  const [isCustomColorPickerOpen, setIsCustomColorPickerOpen] = useState(false)
  const [backgroundNotice, setBackgroundNotice] = useState('')
  const [backgroundBusy, setBackgroundBusy] = useState(false)
  const [editingId, setEditingId] = useState<string>('')
  const [newModel, setNewModel] = useState('')
  const [newProvider, setNewProvider] = useState({ name: '', baseUrl: '' })
  const [addingProvider, setAddingProvider] = useState(false)
  const [connectionTesting, setConnectionTesting] = useState(false)
  const [connectionNotice, setConnectionNotice] = useState('')
  const [saved, setSaved] = useState(false)
  // 「已保存」提示的定时器句柄（persist 内 clearTimeout 复用，防快速连续操作堆叠定时器）
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 色轮拖动会连续触发 input；短暂防抖后再落盘，既支持实时预览也避免频繁写 settings.json。
  const colorSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 文本输入本地草稿，失焦才写盘，避免每击键一次 settings.json 写入
  const [drafts, setDrafts] = useState<Record<string, { baseUrl?: string; token?: string }>>({})
  const [promptDraft, setPromptDraft] = useState<string | null>(null)
  // 存储管理
  const [storage, setStorage] = useState<StorageStats | null>(null)
  const [cleaning, setCleaning] = useState<StorageCategory | null>(null)
  const [storageNotice, setStorageNotice] = useState('')
  const [settingsQuery, setSettingsQuery] = useState('')
  const [diagnostics, setDiagnostics] = useState<PerformanceDiagnostics | null>(null)
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false)
  const [diagnosticsNotice, setDiagnosticsNotice] = useState('')
  const [mergeTempDraft, setMergeTempDraft] = useState('')
  const [mergeTempNotice, setMergeTempNotice] = useState('')
  const [activeGroup, setActiveGroup] = useState('appearance')
  const settingsSearchRef = useRef<HTMLInputElement>(null)

  const refreshStorage = (): void => {
    window.api
      .getStorageStats()
      .then(setStorage)
      .catch(() => {})
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!active) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        settingsSearchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active])

  useEffect(() => {
    let disposed = false
    const applySettings = (next: AppSettings): void => {
      if (disposed) return
      // HMR 时预加载层可能短暂仍返回旧版设置结构，渲染端以同平台值兜底，避免覆盖主进程默认。
      const appearanceDefaults = getPlatformAppearanceDefaults()
      const nextSettings: AppSettings = {
        ...next,
        backgroundAppearance: next.backgroundAppearance ?? DEFAULT_BACKGROUND_APPEARANCE,
        cursorEffects: next.cursorEffects ?? appearanceDefaults.cursorEffects,
        performanceMode: next.performanceMode ?? appearanceDefaults.performanceMode
      }
      setSettings(nextSettings)
      setMergeTempDraft(nextSettings.mergeTempCustomPath)
      setCustomAccent(nextSettings.customAccent || '#1687d9')
      applyBackgroundAppearance(nextSettings.backgroundAppearance)
      applyPerformanceMode(nextSettings.performanceMode)
      // 设置广播只刷新数据；用户正在编辑的非当前平台必须保持选中，不能因为
      // 任一保存操作就被强制跳回当前使用的平台。首次加载或平台被删除时才回退。
      setEditingId((currentId) =>
        nextSettings.aiProviders.some((provider) => provider.id === currentId)
          ? currentId
          : nextSettings.activeProviderId
      )
    }

    // 设置页常驻时也必须接收主进程的归一化结果。否则点击开关后的乐观状态，
    // 可能被首次异步读取或其他页面的旧设置响应覆盖，视觉上就像“点了没反应”。
    const unsubscribe = window.api.onSettingsChange(applySettings)
    void window.api.getSettings().then(applySettings)
    refreshStorage()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const openSafety = (): void => {
      setActiveGroup('safety')
      setSettingsQuery('')
      requestAnimationFrame(() => document.getElementById('settings-group-safety')?.focus())
    }
    window.addEventListener('settings:safety:open', openSafety)
    return () => window.removeEventListener('settings:safety:open', openSafety)
  }, [])

  const cleanStorage = async (category: StorageCategory): Promise<void> => {
    setCleaning(category)
    setStorageNotice('')
    try {
      const result = await window.api.cleanStorage(category)
      setStorageNotice(`已释放 ${formatBytes(result.freedBytes)}`)
      refreshStorage()
    } catch {
      setStorageNotice('清理失败')
    } finally {
      setCleaning(null)
    }
  }

  const loadDiagnostics = async (): Promise<void> => {
    setDiagnosticsBusy(true)
    setDiagnosticsNotice('')
    try {
      setDiagnostics(await window.api.getPerformanceDiagnostics())
    } catch (error) {
      setDiagnosticsNotice(`读取失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDiagnosticsBusy(false)
    }
  }

  const copyDiagnostics = async (): Promise<void> => {
    if (!diagnostics) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2))
      setDiagnosticsNotice('诊断信息已复制到剪贴板，仅包含 GPU 与功能状态。')
    } catch {
      setDiagnosticsNotice('复制失败，请手动选择下方内容。')
    }
  }

  if (!settings) {
    return (
      <div className="page">
        <p className="muted">设置加载中…</p>
      </div>
    )
  }

  const persist = async (patch: Partial<AppSettings>): Promise<boolean> => {
    // 主题色板先乐观写入本地状态，避免 IPC 往返期间仍由默认海洋蓝按钮显示为选中。
    // 主进程返回归一化结果后再覆盖，非法配置仍会被安全回退。
    setSettings((current) => (current ? { ...current, ...patch } : current))
    try {
      const next = await window.api.updateSettings(patch)
      setSettings(next)
      if (patch.themePalette && next.themePalette !== patch.themePalette) {
        // 防御性处理：主题注册遗漏时，不让 UI 与实际落盘状态悄然分叉。
        applyTheme(next.theme, next.themePalette, next.customAccent)
      }
    } catch {
      // 写入失败时恢复主进程中的最新设置，避免停留在无法持久化的乐观状态。
      const next = await window.api.getSettings()
      setSettings(next)
      applyTheme(next.theme, next.themePalette, next.customAccent)
      return false
    }
    setSaved(true)
    // 连续快速操作（如拖滑杆）时清除上一个定时器，提示停留时间从最后一次操作起算
    clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSaved(false), 1500)
    return true
  }

  const selectMergeTempDirectory = async (): Promise<void> => {
    setMergeTempNotice('')
    try {
      const selected = await window.api.selectMergeTempDirectory()
      if (selected) setMergeTempDraft(selected)
    } catch (error) {
      setMergeTempNotice(`目录不可用：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const saveMergeTempDirectory = async (): Promise<void> => {
    const path = mergeTempDraft.trim()
    if (!path) {
      setMergeTempNotice('请先选择或输入一个绝对目录。')
      return
    }
    try {
      if (!(await persist({ mergeTempLocation: 'custom', mergeTempCustomPath: path }))) {
        setMergeTempNotice('保存失败，请检查目录权限。')
        return
      }
      setMergeTempNotice('自定义临时目录已保存。')
    } catch {
      setMergeTempNotice('保存失败，请检查目录权限。')
    }
  }

  const editing: AiProviderConfig =
    settings.aiProviders.find((p) => p.id === editingId) ?? settings.aiProviders[0]

  const settingsQueryNormalized = settingsQuery.trim().toLocaleLowerCase()
  const visibleGroups = settingsQueryNormalized
    ? SETTINGS_GROUPS.filter((group) =>
        `${group.label} ${group.description} ${group.keywords.join(' ')}`
          .toLocaleLowerCase()
          .includes(settingsQueryNormalized)
      )
    : SETTINGS_GROUPS

  const isGroupActive = (id: string): boolean => activeGroup === id

  const selectGroup = (id: string): void => {
    setActiveGroup(id)
    setSettingsQuery('')
    requestAnimationFrame(() => document.getElementById(`settings-group-${id}`)?.focus())
  }

  const selectFirstSearchResult = (): void => {
    const first = visibleGroups[0]
    if (first) selectGroup(first.id)
  }

  const applyCustomAccent = (nextCustomAccent: string, saveNow = false): void => {
    setCustomAccent(nextCustomAccent)
    applyTheme(settings.theme, 'custom', nextCustomAccent)
    setSettings((current) =>
      current ? { ...current, themePalette: 'custom', customAccent: nextCustomAccent } : current
    )
    clearTimeout(colorSaveTimerRef.current)
    if (saveNow) {
      void persist({ themePalette: 'custom', customAccent: nextCustomAccent })
      return
    }
    colorSaveTimerRef.current = setTimeout(() => {
      void persist({ themePalette: 'custom', customAccent: nextCustomAccent })
    }, 220)
  }

  const applyBackground = (patch: Partial<BackgroundAppearance>, saveNow = false): void => {
    const appearance = { ...settings.backgroundAppearance, ...patch }
    applyBackgroundAppearance(appearance)
    setSettings((current) => (current ? { ...current, backgroundAppearance: appearance } : current))
    if (saveNow) void persist({ backgroundAppearance: appearance })
  }

  const selectBackgroundImage = async (): Promise<void> => {
    setBackgroundBusy(true)
    setBackgroundNotice('')
    try {
      const imagePath = await window.api.selectBackgroundImage()
      if (!imagePath) return
      applyBackground({ imagePath }, true)
      setBackgroundNotice('背景图片已导入，仅保存于本机应用数据中。')
    } catch (error) {
      setBackgroundNotice(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBackgroundBusy(false)
    }
  }

  const clearBackgroundImage = async (): Promise<void> => {
    setBackgroundBusy(true)
    setBackgroundNotice('')
    try {
      const next = await window.api.clearBackgroundImage()
      applyBackgroundAppearance(next.backgroundAppearance)
      setSettings(next)
      setBackgroundNotice('已恢复纯色工作台背景。')
    } catch (error) {
      setBackgroundNotice(`清除失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBackgroundBusy(false)
    }
  }

  const patchProvider = (id: string, patch: Partial<AiProviderConfig>): void => {
    persist({
      aiProviders: settings.aiProviders.map((p) => (p.id === id ? { ...p, ...patch } : p))
    })
  }

  const currentTuning = editing.modelTunings[editing.selectedModel]
  const temperatureEnabled = currentTuning?.temperatureEnabled !== false
  const topPEnabled = currentTuning?.topPEnabled !== false
  const patchCurrentTuning = (patch: Partial<AiProviderConfig['modelTunings'][string]>): void => {
    if (!editing.selectedModel) return
    patchProvider(editing.id, {
      modelTunings: {
        ...editing.modelTunings,
        [editing.selectedModel]: {
          batchSize: currentTuning?.batchSize ?? 40,
          concurrency: currentTuning?.concurrency ?? 3,
          requestTimeoutSeconds: currentTuning?.requestTimeoutSeconds ?? 300,
          temperatureEnabled: currentTuning?.temperatureEnabled !== false,
          temperature: currentTuning?.temperature ?? 0.2,
          topPEnabled: currentTuning?.topPEnabled !== false,
          topP: currentTuning?.topP ?? 1,
          maxOutputTokens: currentTuning?.maxOutputTokens ?? 0,
          ...patch
        }
      }
    })
  }

  const selectProvider = (id: string): void => {
    setEditingId(id)
  }

  const activateProvider = (): void => {
    if (editing.id !== settings.activeProviderId) {
      void persist({ activeProviderId: editing.id })
    }
  }

  const testConnection = async (): Promise<void> => {
    if (!editing.token || !editing.selectedModel || connectionTesting) return
    setConnectionTesting(true)
    setConnectionNotice('')
    try {
      const result = await window.api.testAiConnection(editing.id, editing.selectedModel)
      const preview = result.preview ? ` · 返回：${result.preview}` : ''
      setConnectionNotice(
        `连接成功：${result.providerName} / ${result.model}（${result.latencyMs} ms）${preview}`
      )
    } catch (error) {
      setConnectionNotice(`连接失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setConnectionTesting(false)
    }
  }

  const addModel = (): void => {
    const model = newModel.trim()
    if (!model || editing.models.includes(model)) return
    patchProvider(editing.id, { models: [...editing.models, model] })
    setNewModel('')
  }

  const removeModel = (model: string): void => {
    const models = editing.models.filter((item) => item !== model)
    patchProvider(editing.id, {
      models,
      selectedModel: models.includes(editing.selectedModel)
        ? editing.selectedModel
        : (models[0] ?? '')
    })
  }

  const addCustomProvider = (): void => {
    const name = newProvider.name.trim()
    const baseUrl = newProvider.baseUrl.trim().replace(/\/+$/, '')
    if (!name || !baseUrl) return
    const provider: AiProviderConfig = {
      id: `custom-${crypto.randomUUID()}`,
      name,
      baseUrl,
      token: '',
      apiProtocol: 'openai-chat',
      models: [],
      selectedModel: '',
      modelTunings: {},
      thinkingEnabled: false,
      supportsThinking: false
    }
    persist({
      aiProviders: [...settings.aiProviders, provider],
      activeProviderId: provider.id
    })
    setEditingId(provider.id)
    setNewProvider({ name: '', baseUrl: '' })
    setAddingProvider(false)
  }

  const removeProvider = (id: string): void => {
    const providers = settings.aiProviders.filter((p) => p.id !== id)
    persist({
      aiProviders: providers,
      activeProviderId:
        settings.activeProviderId === id ? (providers[0]?.id ?? '') : settings.activeProviderId
    })
    setEditingId(providers[0]?.id ?? '')
  }

  return (
    <div className="page settings-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>设置</h1>
          <p className="muted">所有配置保存在本地。各平台 Token 独立保存，切换平台不会清除。</p>
        </div>
        {saved && (
          <span className="saved-badge" role="status">
            已保存 ✓
          </span>
        )}
      </header>

      <div className="settings-navigation" aria-label="设置导航">
        <label className="settings-search" aria-label="查找设置项">
          <input
            id="settings-search"
            ref={settingsSearchRef}
            type="search"
            value={settingsQuery}
            onChange={(event) => setSettingsQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                selectFirstSearchResult()
              }
              if (event.key === 'Escape') {
                setSettingsQuery('')
                event.currentTarget.blur()
              }
            }}
            placeholder="例如：并发、Token、删除"
            aria-describedby="settings-search-hint"
          />
          <kbd aria-hidden="true">⌘ F</kbd>
        </label>
        <span id="settings-search-hint" className="sr-only">
          输入关键词可筛选设置分组；按 Command 或 Control 加 F 可快速定位输入框。
        </span>
        <div className="settings-group-tabs" aria-label="设置分组">
          {SETTINGS_GROUPS.map((group) => (
            <button
              key={group.id}
              type="button"
              aria-current={activeGroup === group.id ? 'page' : undefined}
              className={`settings-group-tab ${activeGroup === group.id ? 'active' : ''}`}
              onClick={() => selectGroup(group.id)}
            >
              <span>{group.label}</span>
              <small>{group.description}</small>
            </button>
          ))}
        </div>
        {settingsQuery && (
          <div className="settings-search-results" role="listbox" aria-label="设置搜索结果">
            {visibleGroups.length > 0 ? (
              visibleGroups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  role="option"
                  className="settings-search-result"
                  onClick={() => selectGroup(group.id)}
                >
                  <b>{group.label}</b>
                  <span>{group.description}</span>
                </button>
              ))
            ) : (
              <p className="settings-no-results" role="status">
                没有匹配的设置分组，请换个关键词试试。
              </p>
            )}
          </div>
        )}
      </div>

      <section
        id="settings-group-appearance"
        className="settings-card"
        hidden={!isGroupActive('appearance')}
        tabIndex={-1}
      >
        <h2>外观主题</h2>
        <div className="mode-tabs">
          {THEME_TABS.map((tab) => (
            <button
              key={tab.key}
              className={`mode-tab ${settings.theme === tab.key ? 'active' : ''}`}
              onClick={() => {
                applyTheme(tab.key, settings.themePalette, customAccent)
                persist({ theme: tab.key })
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <p className="settings-hint">选择一套预设，或用跨平台色轮创建只属于你的强调色。</p>
        <div className="palette-grid" aria-label="预设强调色方案">
          {PALETTE_OPTIONS.map((palette) => (
            <button
              key={palette.key}
              data-spotlight=""
              className={`palette-option ${settings.themePalette === palette.key ? 'active' : ''}`}
              aria-pressed={settings.themePalette === palette.key}
              onClick={() => {
                applyTheme(settings.theme, palette.key, customAccent)
                persist({ themePalette: palette.key })
              }}
            >
              <span className={`palette-swatch palette-swatch-${palette.key}`} aria-hidden="true" />
              <span>
                <b>{palette.label}</b>
                <small>{palette.description}</small>
              </span>
            </button>
          ))}
        </div>
        <div className={`custom-palette ${settings.themePalette === 'custom' ? 'active' : ''}`}>
          <button
            type="button"
            className="custom-palette-select"
            aria-pressed={settings.themePalette === 'custom'}
            onClick={() => applyCustomAccent(customAccent, true)}
          >
            <span
              className="palette-swatch palette-swatch-custom"
              style={{ background: customAccent }}
              aria-hidden="true"
            />
            <span>
              <b>{CUSTOM_PALETTE.label}</b>
              <small>{CUSTOM_PALETTE.description}</small>
            </span>
          </button>
          <div className="custom-color-picker">
            <button
              type="button"
              className="custom-color-picker-trigger"
              aria-expanded={isCustomColorPickerOpen}
              aria-controls="custom-accent-picker"
              onClick={() => setIsCustomColorPickerOpen((open) => !open)}
            >
              <span
                className="custom-color-preview"
                style={{ background: customAccent }}
                aria-hidden="true"
              />
              <span>选择颜色</span>
            </button>
            <output>{customAccent.toUpperCase()}</output>
            {isCustomColorPickerOpen && (
              <div id="custom-accent-picker" className="custom-color-picker-popover">
                <HexColorPicker
                  color={customAccent}
                  aria-label="通过色轮选择自定义强调色"
                  onChange={applyCustomAccent}
                />
                <label className="custom-color-hex-input">
                  <span>HEX</span>
                  <HexColorInput
                    color={customAccent}
                    prefixed
                    onChange={(color) => applyCustomAccent(color, true)}
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="settings-card background-settings" hidden={!isGroupActive('appearance')}>
        <div className="background-settings-heading">
          <div>
            <h2>工作台背景</h2>
            <p className="muted">图片会导入应用私有目录。内容层遮罩调至 0% 可显示无蒙层原图。</p>
          </div>
          <div className="background-actions">
            <button
              className="secondary"
              onClick={() => void selectBackgroundImage()}
              disabled={backgroundBusy}
            >
              {backgroundBusy ? '处理中…' : '选择图片'}
            </button>
            <button
              className="secondary"
              onClick={() => void clearBackgroundImage()}
              disabled={backgroundBusy || !settings.backgroundAppearance.imagePath}
            >
              移除图片
            </button>
          </div>
        </div>
        <div className="background-preview" aria-label="工作台背景预览">
          {settings.backgroundAppearance.imagePath ? (
            <img src={mediaUrl(settings.backgroundAppearance.imagePath)} alt="当前工作台背景" />
          ) : (
            <div className="background-preview-empty">尚未选择图片</div>
          )}
          <div className="background-preview-surface" aria-hidden="true">
            <span>媒体工作台</span>
            <small>预览你的内容层可读性</small>
          </div>
        </div>
        {backgroundNotice && (
          <p className="notice-inline" role="status">
            {backgroundNotice}
          </p>
        )}
        <label className="appearance-slider">
          <span>图片可见度</span>
          <input
            type="range"
            min={0}
            max={100}
            value={settings.backgroundAppearance.imageOpacity}
            onInput={(event) =>
              applyBackground({ imageOpacity: Number(event.currentTarget.value) })
            }
            onChange={(event) =>
              applyBackground({ imageOpacity: Number(event.currentTarget.value) }, true)
            }
          />
          <output>{settings.backgroundAppearance.imageOpacity}%</output>
        </label>
        <label className="appearance-slider">
          <span>磨砂强度</span>
          <input
            type="range"
            min={0}
            max={32}
            value={settings.backgroundAppearance.blur}
            onInput={(event) => applyBackground({ blur: Number(event.currentTarget.value) })}
            onChange={(event) => applyBackground({ blur: Number(event.currentTarget.value) }, true)}
          />
          <output>{settings.backgroundAppearance.blur}px</output>
        </label>
        <label className="appearance-slider">
          <span>内容层不透明度</span>
          <input
            type="range"
            min={0}
            max={100}
            value={settings.backgroundAppearance.surfaceOpacity}
            onInput={(event) =>
              applyBackground({ surfaceOpacity: Number(event.currentTarget.value) })
            }
            onChange={(event) =>
              applyBackground({ surfaceOpacity: Number(event.currentTarget.value) }, true)
            }
          />
          <output>{settings.backgroundAppearance.surfaceOpacity}%</output>
        </label>
        <div className="background-fit" role="group" aria-label="背景图片适配方式">
          <span>图片适配</span>
          <div className="mode-tabs">
            <button
              className={`mode-tab ${settings.backgroundAppearance.fit === 'cover' ? 'active' : ''}`}
              onClick={() => applyBackground({ fit: 'cover' }, true)}
            >
              铺满裁切
            </button>
            <button
              className={`mode-tab ${settings.backgroundAppearance.fit === 'contain' ? 'active' : ''}`}
              onClick={() => applyBackground({ fit: 'contain' }, true)}
            >
              完整显示
            </button>
          </div>
        </div>
      </section>

      <section className="settings-card" hidden={!isGroupActive('appearance')}>
        <h2>光标动效</h2>
        <p className="muted">
          提供光点、霓虹、星尘、流星、彩纸和水波六种方案；点击会按当前方案产生专属反馈，并跟随当前主题强调色。
          系统开启「减少动态效果」时会自动停用。卡片悬停光斑与磁吸效果始终启用。
        </p>
        <div className="mode-tabs cursor-effect-tabs" role="tablist" aria-label="光标动效模式">
          {CURSOR_EFFECT_TABS.map((tab) => (
            <button
              key={tab.key}
              className={`mode-tab ${settings.cursorEffects === tab.key ? 'active' : ''}`}
              role="tab"
              aria-selected={settings.cursorEffects === tab.key}
              onClick={() => persist({ cursorEffects: tab.key })}
            >
              <span>{tab.label}</span>
              <small>{tab.description}</small>
            </button>
          ))}
        </div>
      </section>

      <section
        id="settings-group-performance"
        className="settings-card"
        hidden={!isGroupActive('performance')}
        tabIndex={-1}
      >
        <h2>任务并发</h2>
        <p className="muted">除视频合并外，所有模块共用的线程数（1–20，默认 5）。</p>
        <div className="slider-row">
          <input
            type="range"
            min={1}
            max={20}
            value={settings.concurrency}
            onChange={(event) => persist({ concurrency: Number(event.target.value) })}
          />
          <b>{settings.concurrency}</b>
        </div>
      </section>

      <section className="settings-card" hidden={!isGroupActive('performance')}>
        <h2>视觉性能</h2>
        <p className="muted">
          降低视觉效果会关闭高成本背景模糊、重阴影和装饰动画；不会影响任务进度、媒体播放或键盘操作。
        </p>
        <div className="mode-tabs" role="group" aria-label="视觉性能模式">
          <button
            className={`mode-tab ${settings.performanceMode === 'reduced' ? 'active' : ''}`}
            aria-pressed={settings.performanceMode === 'reduced'}
            onClick={() => {
              applyPerformanceMode('reduced')
              void persist({ performanceMode: 'reduced' })
            }}
          >
            降低视觉效果（推荐 Windows）
          </button>
          <button
            className={`mode-tab ${settings.performanceMode === 'standard' ? 'active' : ''}`}
            aria-pressed={settings.performanceMode === 'standard'}
            onClick={() => {
              applyPerformanceMode('standard')
              void persist({ performanceMode: 'standard' })
            }}
          >
            完整视觉效果
          </button>
        </div>
      </section>

      <section className="settings-card" hidden={!isGroupActive('performance')}>
        <h2>扫描并发</h2>
        <p className="muted">目录遍历的子目录并行数（1–16，默认 4）。NAS 或大目录树建议调高。</p>
        <div className="slider-row">
          <input
            type="range"
            min={1}
            max={16}
            value={settings.scanConcurrency}
            onChange={(event) => persist({ scanConcurrency: Number(event.target.value) })}
          />
          <b>{settings.scanConcurrency}</b>
        </div>
      </section>

      <section className="settings-card" hidden={!isGroupActive('performance')}>
        <h2>FFmpeg 进程池</h2>
        <p className="muted">
          同时运行的 ffmpeg/ffprobe 进程数上限（1–8，默认 4）。截帧、探测、体检共用此池，
          防止并发任务叠加导致进程数打满 CPU。
        </p>
        <div className="slider-row">
          <input
            type="range"
            min={1}
            max={8}
            value={settings.ffmpegPoolSize}
            onChange={(event) => persist({ ffmpegPoolSize: Number(event.target.value) })}
          />
          <b>{settings.ffmpegPoolSize}</b>
        </div>
      </section>

      <section className="settings-card" hidden={!isGroupActive('performance')}>
        <h2>视频硬件转码加速</h2>
        <p className="muted">
          仅在视频参数不一致、必须转码时生效。启用后会先验证 NVIDIA NVENC 可用性；FFmpeg、驱动或显卡
          不支持时自动使用 CPU x264。仅视频编码由 GPU 加速，解码、缩放和补边仍由 CPU 完成；Windows
          默认开启，macOS 默认关闭；素材参数一致时始终无重编码拼接。
        </p>
        <label className="confirm-check">
          <input
            className="check-input"
            type="checkbox"
            checked={settings.nvencEnabled}
            onChange={(event) => persist({ nvencEnabled: event.target.checked })}
          />
          <span className="muted">启用 NVIDIA NVENC 硬件加速</span>
        </label>
      </section>

      <section className="settings-card" hidden={!isGroupActive('performance')}>
        <h2>合并性能与临时目录</h2>
        <p className="muted">
          默认把可续传中间段放在工作区隐藏目录，避免 Windows 系统盘与素材盘跨盘读写。
        </p>
        <div className="mode-tabs">
          {(
            [
              ['source-disk', '工作区同盘（推荐）'],
              ['system', '系统临时目录'],
              ['custom', '自定义目录']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`mode-tab ${settings.mergeTempLocation === key ? 'active' : ''}`}
              onClick={() => {
                setMergeTempNotice('')
                void persist({ mergeTempLocation: key })
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {settings.mergeTempLocation === 'custom' && (
          <div className="model-add">
            <input
              value={mergeTempDraft}
              placeholder="输入绝对路径，例如 D:\\MediaTemp"
              onChange={(event) => setMergeTempDraft(event.target.value)}
            />
            <button className="secondary" type="button" onClick={() => void selectMergeTempDirectory()}>
              选择目录
            </button>
            <button type="button" onClick={() => void saveMergeTempDirectory()}>
              保存目录
            </button>
          </div>
        )}
        {settings.mergeTempLocation === 'custom' && (
          <p className="muted">
            路径在保存时验证可写；仅切换到自定义模式不会创建目录或写入草稿。
            {mergeTempNotice && <span className="notice-inline"> {mergeTempNotice}</span>}
          </p>
        )}
        <p className="muted">
          转码片段并行数（GPU 完整流水线最高 2 路，仍受全局 FFmpeg 进程池限制）。
        </p>
        <div className="slider-row">
          <input
            type="range"
            min={1}
            max={4}
            value={settings.mergeTranscodeConcurrency}
            onChange={(event) => persist({ mergeTranscodeConcurrency: Number(event.target.value) })}
          />
          <b>{settings.mergeTranscodeConcurrency}</b>
        </div>
        <label className="confirm-check">
          <input
            className="check-input"
            type="checkbox"
            checked={settings.cudaPipelineEnabled}
            onChange={(event) => persist({ cudaPipelineEnabled: event.target.checked })}
          />
          <span className="muted">
            实验性完整 GPU 流水线（NVDEC + CUDA 缩放/补边 + NVENC；失败按段降级）
          </span>
        </label>
      </section>

      <section className="settings-card" hidden={!isGroupActive('performance')}>
        <h2>本机图形诊断</h2>
        <p className="muted">
          仅在你点击读取时返回当前 GPU 和 Chromium
          功能状态；不写入设置、不上传网络，可用于排查渲染卡顿。
        </p>
        <div className="settings-inline-actions">
          <button
            className="secondary"
            onClick={() => void loadDiagnostics()}
            disabled={diagnosticsBusy}
          >
            {diagnosticsBusy ? '读取中…' : '读取图形状态'}
          </button>
          <button
            className="secondary"
            onClick={() => void copyDiagnostics()}
            disabled={!diagnostics}
          >
            复制诊断
          </button>
        </div>
        {diagnosticsNotice && (
          <p className="notice-inline" role="status">
            {diagnosticsNotice}
          </p>
        )}
        {diagnostics && (
          <pre className="performance-diagnostics" tabIndex={0}>
            {JSON.stringify(diagnostics, null, 2)}
          </pre>
        )}
      </section>

      <section
        id="settings-group-safety"
        className="settings-card"
        hidden={!isGroupActive('safety')}
        tabIndex={-1}
      >
        <h2>删除方式</h2>
        <p className="muted">
          清理/去重/合并删源等用户数据删除默认移入系统回收站（误删可恢复）；关闭后为永久删除。
        </p>
        <div className="mode-tabs">
          <button
            className={`mode-tab ${settings.deleteToTrash ? 'active' : ''}`}
            onClick={() => persist({ deleteToTrash: true })}
          >
            移入回收站（推荐）
          </button>
          <button
            className={`mode-tab ${settings.deleteToTrash ? '' : 'active'}`}
            onClick={() => persist({ deleteToTrash: false })}
          >
            永久删除
          </button>
        </div>
      </section>

      <section
        id="settings-group-ai"
        className="settings-card"
        hidden={!isGroupActive('ai')}
        tabIndex={-1}
      >
        <h2>AI 平台</h2>
        <div className="mode-tabs provider-tabs" role="tablist" aria-label="AI 平台列表">
          {settings.aiProviders.map((provider) => (
            <button
              key={provider.id}
              className={`mode-tab ${editingId === provider.id ? 'active' : ''}`}
              role="tab"
              aria-selected={editingId === provider.id}
              onClick={() => selectProvider(provider.id)}
            >
              {provider.name}
              {provider.id === settings.activeProviderId && ' · 使用中'}
              {provider.token && ' 🔑'}
            </button>
          ))}
          <button className="mode-tab" onClick={() => setAddingProvider((v) => !v)}>
            ＋ 自定义
          </button>
        </div>

        {addingProvider && (
          <div className="model-add">
            <input
              placeholder="平台名称，如 某某镜像"
              value={newProvider.name}
              onChange={(event) =>
                setNewProvider((prev) => ({ ...prev, name: event.target.value }))
              }
            />
            <input
              placeholder="OpenAI 兼容 baseUrl，如 https://api.example.com/v1"
              value={newProvider.baseUrl}
              onChange={(event) =>
                setNewProvider((prev) => ({ ...prev, baseUrl: event.target.value }))
              }
            />
            <button
              className="secondary"
              onClick={addCustomProvider}
              disabled={!newProvider.name.trim() || !newProvider.baseUrl.trim()}
            >
              添加
            </button>
          </div>
        )}

        {editing && (
          <>
            <label className="field">
              <span>API 协议</span>
              <select
                value={editing.apiProtocol}
                onChange={(event) =>
                  patchProvider(editing.id, {
                    apiProtocol: event.target.value as AiProviderConfig['apiProtocol']
                  })
                }
              >
                {AI_PROTOCOL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>
                Base URL
                {editing.apiProtocol === 'openai-chat'
                  ? '（自动拼接 /chat/completions）'
                  : editing.apiProtocol === 'openai-responses'
                    ? '（自动拼接 /responses）'
                    : editing.apiProtocol === 'anthropic-messages'
                      ? '（自动拼接 /messages）'
                      : '（使用 /models/{模型}:generateContent）'}
              </span>
              <input
                value={drafts[editing.id]?.baseUrl ?? editing.baseUrl}
                onChange={(event) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [editing.id]: { ...prev[editing.id], baseUrl: event.target.value }
                  }))
                }
                onBlur={() => {
                  const value = drafts[editing.id]?.baseUrl
                  if (value !== undefined && value !== editing.baseUrl) {
                    patchProvider(editing.id, { baseUrl: value })
                  }
                }}
              />
            </label>
            <label className="field">
              <span>API Token{editing.token ? '（已保存，手动清空才会删除）' : '（未配置）'}</span>
              <input
                type="password"
                placeholder="粘贴 Token，失焦后自动保存"
                value={drafts[editing.id]?.token ?? editing.token}
                onChange={(event) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [editing.id]: { ...prev[editing.id], token: event.target.value }
                  }))
                }
                onBlur={() => {
                  const value = drafts[editing.id]?.token
                  if (value !== undefined && value !== editing.token) {
                    patchProvider(editing.id, { token: value })
                  }
                }}
              />
            </label>
            <div className="settings-inline-actions">
              {editing.id !== settings.activeProviderId && (
                <button className="secondary" onClick={activateProvider}>
                  设为当前使用的平台
                </button>
              )}
              <button
                className="secondary"
                onClick={() => void testConnection()}
                disabled={connectionTesting || !editing.token || !editing.selectedModel}
                title={
                  !editing.token
                    ? '请先填写 API Token'
                    : !editing.selectedModel
                      ? '请先选择模型'
                      : ''
                }
              >
                {connectionTesting ? '测试中…' : '测试当前模型连接'}
              </button>
            </div>
            {connectionNotice && (
              <p className="notice-inline" role="status">
                {connectionNotice}
              </p>
            )}
            {editing.supportsThinking && (
              <label className="confirm-check">
                <input
                  className="confirm-check-input"
                  type="checkbox"
                  checked={editing.thinkingEnabled}
                  onChange={(event) =>
                    patchProvider(editing.id, { thinkingEnabled: event.target.checked })
                  }
                />
                <span>
                  启用思考模式
                  <small className="muted">
                    （默认关闭；开启会增加命名准确性，但通常响应更慢。仅部分模型支持）
                  </small>
                </span>
              </label>
            )}
            {editing.selectedModel && (
              <div className="field">
                <span>当前模型请求参数</span>
                <div className="model-tuning-grid">
                  <label className="field">
                    <span>每批文件数（1–100）</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={editing.modelTunings[editing.selectedModel]?.batchSize ?? 40}
                      onChange={(event) =>
                        patchCurrentTuning({ batchSize: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>请求并发数（1–10）</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={editing.modelTunings[editing.selectedModel]?.concurrency ?? 3}
                      onChange={(event) =>
                        patchCurrentTuning({ concurrency: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>单请求超时（5–900 秒）</span>
                    <input
                      type="number"
                      min={5}
                      max={900}
                      value={
                        editing.modelTunings[editing.selectedModel]?.requestTimeoutSeconds ?? 300
                      }
                      onChange={(event) =>
                        patchCurrentTuning({ requestTimeoutSeconds: Number(event.target.value) })
                      }
                    />
                  </label>
                  <div className="sampling-controls" aria-label="采样参数">
                    <div className="sampling-control">
                      <div className="sampling-control-header">
                        <label htmlFor="temperature-enabled">温度</label>
                        <button
                          type="button"
                          className="sampling-switch"
                          role="switch"
                          aria-checked={temperatureEnabled}
                          disabled={editing.thinkingEnabled}
                          onClick={() =>
                            patchCurrentTuning({ temperatureEnabled: !temperatureEnabled })
                          }
                        >
                          <span className="sampling-switch-track" aria-hidden="true" />
                          <span>{temperatureEnabled ? '已发送' : '不发送'}</span>
                        </button>
                      </div>
                      <input
                        aria-label="温度"
                        type="number"
                        min={0}
                        max={2}
                        step={0.1}
                        disabled={editing.thinkingEnabled || !temperatureEnabled}
                        value={currentTuning?.temperature ?? 0.2}
                        onChange={(event) =>
                          patchCurrentTuning({ temperature: Number(event.target.value) })
                        }
                      />
                      <small>建议 0–0.4，数值越低结果越稳定</small>
                    </div>
                    <div className="sampling-control">
                      <div className="sampling-control-header">
                        <label htmlFor="top-p-enabled">Top P</label>
                        <button
                          type="button"
                          className="sampling-switch"
                          role="switch"
                          aria-checked={topPEnabled}
                          disabled={editing.thinkingEnabled}
                          onClick={() => patchCurrentTuning({ topPEnabled: !topPEnabled })}
                        >
                          <span className="sampling-switch-track" aria-hidden="true" />
                          <span>{topPEnabled ? '已发送' : '不发送'}</span>
                        </button>
                      </div>
                      <input
                        aria-label="Top P"
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        disabled={editing.thinkingEnabled || !topPEnabled}
                        value={currentTuning?.topP ?? 1}
                        onChange={(event) =>
                          patchCurrentTuning({ topP: Number(event.target.value) })
                        }
                      />
                      <small>关闭后请求不附带 top_p 参数</small>
                    </div>
                  </div>
                  <label className="field">
                    <span>最大输出 Token（0=自动，最多 32768）</span>
                    <input
                      type="number"
                      min={0}
                      max={32768}
                      step={256}
                      value={editing.modelTunings[editing.selectedModel]?.maxOutputTokens ?? 0}
                      onChange={(event) =>
                        patchCurrentTuning({ maxOutputTokens: Number(event.target.value) })
                      }
                    />
                  </label>
                </div>
                <small className="muted">
                  仅作用于当前模型；不同模型会独立保存。关闭开关可兼容不接受采样参数的网关；思考模式下会暂时禁用采样控制。最大输出
                  Token 设为 0 时按批量自动计算。
                </small>
              </div>
            )}
            {editing.models.length > 0 && (
              <label className="field">
                <span>默认模型</span>
                <select
                  value={editing.selectedModel}
                  onChange={(event) =>
                    patchProvider(editing.id, { selectedModel: event.target.value })
                  }
                >
                  {editing.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="model-list">
              {editing.models.map((model) => (
                <span key={model} className="model-chip">
                  {model}
                  <button className="chip-remove" title="移除" onClick={() => removeModel(model)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="model-add">
              <input
                placeholder="添加模型 ID，如 deepseek-v4-flash"
                value={newModel}
                onChange={(event) => setNewModel(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && addModel()}
              />
              <button className="secondary" onClick={addModel} disabled={!newModel.trim()}>
                添加
              </button>
            </div>
            {!BUILT_IN_PROVIDER_IDS.has(editing.id) && (
              <div>
                <button className="danger-button" onClick={() => removeProvider(editing.id)}>
                  删除此平台
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="settings-card" hidden={!isGroupActive('ai')}>
        <h2>AI 重命名 Prompt 模板</h2>
        <p className="muted">
          可用变量：{'{{parentFolder}}'}（父文件夹名）、{'{{fileName}}'}
          （当前文件名）。同一父目录在一个批次中只声明一次；扩展名不发送给 AI。
        </p>
        <textarea
          rows={8}
          maxLength={8000}
          value={promptDraft ?? settings.promptTemplate}
          onChange={(event) => setPromptDraft(event.target.value)}
          onBlur={() => {
            if (promptDraft !== null && promptDraft !== settings.promptTemplate) {
              persist({ promptTemplate: promptDraft })
            }
          }}
        />
        <p className="muted">
          {(promptDraft ?? settings.promptTemplate).length}/8000 字符。命名要求每个 AI
          批次仅发送一次。
        </p>
      </section>

      <section className="settings-card" hidden={!isGroupActive('safety')}>
        <h2>存储管理</h2>
        <p className="muted">
          应用运行产生的临时数据。截帧缓存可随时清理（下次重新截帧）；合并断点工作目录清理后，
          未完成的转码合并将从头开始。
        </p>
        {storageNotice && (
          <p className="notice-inline" role="status">
            {storageNotice}
          </p>
        )}
        <div className="storage-row">
          <span>截帧缓存</span>
          <b>{storage ? formatBytes(storage.framesBytes) : '…'}</b>
          <button
            className="secondary"
            disabled={cleaning !== null || !storage || storage.framesBytes === 0}
            onClick={() => cleanStorage('frames')}
          >
            {cleaning === 'frames' ? '清理中…' : '清理'}
          </button>
        </div>
        <div className="storage-row">
          <span>合并断点工作目录</span>
          <b>{storage ? formatBytes(storage.mergeTempBytes) : '…'}</b>
          <button
            className="secondary"
            disabled={cleaning !== null || !storage || storage.mergeTempBytes === 0}
            onClick={() => cleanStorage('merge-temp')}
          >
            {cleaning === 'merge-temp' ? '清理中…' : '清理'}
          </button>
        </div>
        <div className="storage-row">
          <span>操作日志（{storage?.opLogCount ?? '…'} 份，超过 100 份自动修剪）</span>
          <b>{storage ? formatBytes(storage.opLogBytes) : '…'}</b>
          <button
            className="secondary"
            disabled={cleaning !== null || !storage || storage.opLogBytes === 0}
            onClick={() => cleanStorage('op-logs')}
          >
            {cleaning === 'op-logs' ? '清理中…' : '清空'}
          </button>
        </div>
        <OperationTimeline />
      </section>
    </div>
  )
}

export default SettingsPage
