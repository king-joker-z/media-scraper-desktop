import { useEffect, useRef, useState } from 'react'
import type {
  AiProviderConfig,
  AppSettings,
  BackgroundAppearance,
  StorageCategory,
  StorageStats,
  ThemeMode,
  ThemePalette,
  UpdateStatus
} from '../../../shared/types'
import OpLogPanel from '../components/OpLogPanel'
import { formatBytes } from '../utils/format'
import {
  applyBackgroundAppearance,
  applyTheme,
  DEFAULT_BACKGROUND_APPEARANCE
} from '../utils/theme'
import { mediaUrl } from '../utils/media'

const THEME_TABS: { key: ThemeMode; label: string }[] = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' }
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
  { key: 'rose', label: '樱花粉', description: '柔和轻快，为界面增添温暖层次' }
]

const CUSTOM_PALETTE: { key: ThemePalette; label: string; description: string } = {
  key: 'custom',
  label: '自定义强调色',
  description: '通过系统色轮选择并实时预览'
}

const UPDATE_STATE_LABELS: Record<UpdateStatus['state'], string> = {
  idle: '尚未检查',
  checking: '正在检查更新…',
  available: '发现新版本',
  none: '已是最新版本',
  downloading: '正在下载…',
  downloaded: '下载完成',
  error: '检查失败'
}

function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  // 色彩选择器使用本地值驱动，防止异步 settings IPC 回包短暂覆盖吸管刚选中的颜色。
  const [customAccent, setCustomAccent] = useState('#1687d9')
  const [backgroundNotice, setBackgroundNotice] = useState('')
  const [backgroundBusy, setBackgroundBusy] = useState(false)
  const [editingId, setEditingId] = useState<string>('')
  const [newModel, setNewModel] = useState('')
  const [newProvider, setNewProvider] = useState({ name: '', baseUrl: '' })
  const [addingProvider, setAddingProvider] = useState(false)
  const [saved, setSaved] = useState(false)
  // 「已保存」提示的定时器句柄（persist 内 clearTimeout 复用，防快速连续操作堆叠定时器）
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 色轮拖动会连续触发 input；短暂防抖后再落盘，既支持实时预览也避免频繁写 settings.json。
  const colorSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 文本输入本地草稿，失焦才写盘，避免每击键一次 settings.json 写入
  const [drafts, setDrafts] = useState<Record<string, { baseUrl?: string; token?: string }>>({})
  const [promptDraft, setPromptDraft] = useState<string | null>(null)
  // 存储管理（S4）与自动更新（F7）
  const [storage, setStorage] = useState<StorageStats | null>(null)
  const [cleaning, setCleaning] = useState<StorageCategory | null>(null)
  const [storageNotice, setStorageNotice] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [appVersion, setAppVersion] = useState('')

  const refreshStorage = (): void => {
    window.api
      .getStorageStats()
      .then(setStorage)
      .catch(() => {})
  }

  useEffect(() => {
    window.api.getSettings().then((next) => {
      // HMR 时预加载层可能短暂仍返回旧版设置结构，渲染端先兜底以确保设置页可打开。
      const nextSettings: AppSettings = {
        ...next,
        backgroundAppearance: next.backgroundAppearance ?? DEFAULT_BACKGROUND_APPEARANCE
      }
      setSettings(nextSettings)
      setCustomAccent(nextSettings.customAccent || '#1687d9')
      applyBackgroundAppearance(nextSettings.backgroundAppearance)
      setEditingId(nextSettings.activeProviderId)
    })
    refreshStorage()
    window.api
      .getUpdateStatus()
      .then(setUpdateStatus)
      .catch(() => {})
    window.api
      .getAppVersion()
      .then(setAppVersion)
      .catch(() => {})
    return window.api.onUpdateStatus(setUpdateStatus)
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

  if (!settings) {
    return (
      <div className="page">
        <p className="muted">设置加载中…</p>
      </div>
    )
  }

  const persist = async (patch: Partial<AppSettings>): Promise<void> => {
    const next = await window.api.updateSettings(patch)
    setSettings(next)
    setSaved(true)
    // 连续快速操作（如拖滑杆）时清除上一个定时器，提示停留时间从最后一次操作起算
    clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSaved(false), 1500)
  }

  const editing: AiProviderConfig =
    settings.aiProviders.find((p) => p.id === editingId) ?? settings.aiProviders[0]

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

  const switchActive = (id: string): void => {
    setEditingId(id)
    if (id !== settings.activeProviderId) persist({ activeProviderId: id })
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
      models: [],
      selectedModel: '',
      thinkingEnabled: false
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
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>设置</h1>
          <p className="muted">所有配置保存在本地。各平台 Token 独立保存，切换平台不会清除。</p>
        </div>
        {saved && <span className="saved-badge">已保存 ✓</span>}
      </header>

      <section className="settings-card">
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
        <p className="settings-hint">选择一套预设，或用色轮创建只属于你的强调色。</p>
        <div className="palette-grid" aria-label="预设强调色方案">
          {PALETTE_OPTIONS.map((palette) => (
            <button
              key={palette.key}
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
          <label className="custom-color-picker">
            <span className="sr-only">选择自定义强调色</span>
            <input
              type="color"
              value={customAccent}
              aria-label="选择自定义强调色"
              onInput={(event) => applyCustomAccent(event.currentTarget.value)}
              onChange={(event) => applyCustomAccent(event.currentTarget.value, true)}
            />
            <output>{customAccent.toUpperCase()}</output>
          </label>
        </div>
      </section>

      <section className="settings-card background-settings">
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
        {backgroundNotice && <p className="notice-inline">{backgroundNotice}</p>}
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

      <section className="settings-card">
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

      <section className="settings-card">
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

      <section className="settings-card">
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

      <section className="settings-card">
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

      <section className="settings-card">
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

      <section className="settings-card">
        <h2>AI 平台</h2>
        <div className="mode-tabs">
          {settings.aiProviders.map((provider) => (
            <button
              key={provider.id}
              className={`mode-tab ${editingId === provider.id ? 'active' : ''}`}
              onClick={() => switchActive(provider.id)}
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
              <span>Base URL（OpenAI 兼容，自动拼接 /chat/completions）</span>
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
            {editing.id === 'deepseek' && (
              <label className="confirm-check">
                <input
                  className="check-input"
                  type="checkbox"
                  checked={editing.thinkingEnabled}
                  onChange={(event) =>
                    patchProvider(editing.id, { thinkingEnabled: event.target.checked })
                  }
                />
                <span>
                  启用思考模式
                  <small className="muted">
                    （默认关闭；开启会增加命名准确性，但通常响应更慢）
                  </small>
                </span>
              </label>
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
            {editing.id.startsWith('custom-') && (
              <div>
                <button className="danger-button" onClick={() => removeProvider(editing.id)}>
                  删除此平台
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="settings-card">
        <h2>AI 重命名 Prompt 模板</h2>
        <p className="muted">
          可用变量：{'{{parentFolder}}'}（父文件夹名）、{'{{fileName}}'}
          （当前文件名）。同一父目录在一个批次中只声明一次；扩展名不发送给 AI。
        </p>
        <textarea
          rows={8}
          maxLength={2000}
          value={promptDraft ?? settings.promptTemplate}
          onChange={(event) => setPromptDraft(event.target.value)}
          onBlur={() => {
            if (promptDraft !== null && promptDraft !== settings.promptTemplate) {
              persist({ promptTemplate: promptDraft })
            }
          }}
        />
        <p className="muted">
          {(promptDraft ?? settings.promptTemplate).length}/2000 字符。命名要求每个 AI
          批次仅发送一次。
        </p>
      </section>

      <section className="settings-card">
        <h2>存储管理</h2>
        <p className="muted">
          应用运行产生的临时数据。截帧缓存可随时清理（下次重新截帧）；合并断点工作目录清理后，
          未完成的转码合并将从头开始。
        </p>
        {storageNotice && <p className="notice-inline">{storageNotice}</p>}
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
      </section>

      <section className="settings-card">
        <h2>软件更新</h2>
        <p className="muted">
          当前版本 v{appVersion || '…'}。更新来源于 GitHub Releases（打 v* tag 后由 CI 自动发布）。
        </p>
        <div className="storage-row">
          <span>
            {UPDATE_STATE_LABELS[updateStatus.state]}
            {updateStatus.version ? `：v${updateStatus.version}` : ''}
            {updateStatus.state === 'downloading' && updateStatus.percent !== undefined
              ? ` ${updateStatus.percent}%`
              : ''}
            {updateStatus.state === 'error' && updateStatus.message
              ? `：${updateStatus.message}`
              : ''}
          </span>
          <span className="update-actions">
            {updateStatus.state === 'available' && (
              <button className="secondary" onClick={() => window.api.downloadUpdate()}>
                下载
              </button>
            )}
            {updateStatus.state === 'downloaded' && (
              <button onClick={() => window.api.installUpdate()}>重启安装</button>
            )}
            {(updateStatus.state === 'idle' ||
              updateStatus.state === 'none' ||
              updateStatus.state === 'error') && (
              <button className="secondary" onClick={() => window.api.checkUpdates()}>
                检查更新
              </button>
            )}
          </span>
        </div>
      </section>

      <OpLogPanel />
    </div>
  )
}

export default SettingsPage
