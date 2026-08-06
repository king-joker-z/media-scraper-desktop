import { useEffect, useState } from 'react'
import type { AiProviderConfig, AppSettings } from '../../../shared/types'

function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [editingId, setEditingId] = useState<string>('')
  const [newModel, setNewModel] = useState('')
  const [newProvider, setNewProvider] = useState({ name: '', baseUrl: '' })
  const [addingProvider, setAddingProvider] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.getSettings().then((next) => {
      setSettings(next)
      setEditingId(next.activeProviderId)
    })
  }, [])

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
    setTimeout(() => setSaved(false), 1500)
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
      id: `custom-${Date.now()}`,
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
                value={editing.baseUrl}
                onChange={(event) => patchProvider(editing.id, { baseUrl: event.target.value })}
              />
            </label>
            <label className="field">
              <span>API Token{editing.token ? '（已保存，手动清空才会删除）' : '（未配置）'}</span>
              <input
                type="password"
                placeholder="粘贴 Token 后自动保存"
                value={editing.token}
                onChange={(event) => patchProvider(editing.id, { token: event.target.value })}
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
          可用变量：{'{{parentFolder}}'}（父文件夹名）、{'{{fileName}}'}（当前文件名）、
          {'{{extension}}'}（扩展名）。
        </p>
        <textarea
          rows={8}
          value={settings.promptTemplate}
          onChange={(event) => persist({ promptTemplate: event.target.value })}
        />
      </section>
    </div>
  )
}

export default SettingsPage
