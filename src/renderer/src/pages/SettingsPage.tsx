import { useEffect, useRef, useState } from 'react'
import type {
  AiProviderConfig,
  AppSettings,
  StorageCategory,
  StorageStats,
  ThemeMode,
  ThemePalette,
  UpdateStatus
} from '../../../shared/types'
import OpLogPanel from '../components/OpLogPanel'
import { formatBytes } from '../utils/format'
import { applyTheme } from '../utils/theme'

const THEME_TABS: { key: ThemeMode; label: string }[] = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' }
]

const PALETTE_OPTIONS: { key: ThemePalette; label: string; description: string }[] = [
  { key: 'ocean', label: '海洋蓝', description: '专注、清晰，适合日常整理' },
  { key: 'violet', label: '暮光紫', description: '更具创作感的深邃强调色' },
  { key: 'forest', label: '森林绿', description: '低干扰、舒缓的任务氛围' },
  { key: 'sunset', label: '日落橙', description: '鲜明温暖，突出操作反馈' }
]

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
  const [editingId, setEditingId] = useState<string>('')
  const [newModel, setNewModel] = useState('')
  const [newProvider, setNewProvider] = useState({ name: '', baseUrl: '' })
  const [addingProvider, setAddingProvider] = useState(false)
  const [saved, setSaved] = useState(false)
  // 「已保存」提示的定时器句柄（persist 内 clearTimeout 复用，防快速连续操作堆叠定时器）
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
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
      setSettings(next)
      setEditingId(next.activeProviderId)
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
      selectedModel: ''
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
                applyTheme(tab.key, settings.themePalette)
                persist({ theme: tab.key })
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="palette-grid" aria-label="强调色方案">
          {PALETTE_OPTIONS.map((palette) => (
            <button
              key={palette.key}
              className={`palette-option ${settings.themePalette === palette.key ? 'active' : ''}`}
              onClick={() => {
                applyTheme(settings.theme, palette.key)
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
