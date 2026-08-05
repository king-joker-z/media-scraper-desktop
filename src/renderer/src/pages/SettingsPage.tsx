import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../shared/types'

function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [newModel, setNewModel] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.getSettings().then(setSettings)
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

  const addModel = (): void => {
    const model = newModel.trim()
    if (!model || settings.openRouter.models.includes(model)) return
    persist({
      openRouter: { ...settings.openRouter, models: [...settings.openRouter.models, model] }
    })
    setNewModel('')
  }

  const removeModel = (model: string): void => {
    const models = settings.openRouter.models.filter((item) => item !== model)
    persist({
      openRouter: {
        ...settings.openRouter,
        models,
        selectedModel: models.includes(settings.openRouter.selectedModel)
          ? settings.openRouter.selectedModel
          : (models[0] ?? '')
      }
    })
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>设置</h1>
          <p className="muted">所有配置保存在本地，仅在你触发 AI 重命名时才会访问 OpenRouter。</p>
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
        <h2>OpenRouter（AI 重命名）</h2>
        <p className="muted">
          在 openrouter.ai 申请 API Key。仅发送文件名与目录名，绝不上传视频内容。
        </p>
        <label className="field">
          <span>API Token</span>
          <input
            type="password"
            placeholder="sk-or-..."
            value={settings.openRouter.token}
            onChange={(event) =>
              persist({
                openRouter: { ...settings.openRouter, token: event.target.value }
              })
            }
          />
        </label>
        <label className="field">
          <span>默认模型</span>
          <select
            value={settings.openRouter.selectedModel}
            onChange={(event) =>
              persist({
                openRouter: { ...settings.openRouter, selectedModel: event.target.value }
              })
            }
          >
            {settings.openRouter.models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <div className="model-list">
          {settings.openRouter.models.map((model) => (
            <span key={model} className="model-chip">
              {model}
              <button
                className="chip-remove"
                title="移除"
                onClick={() => removeModel(model)}
                disabled={settings.openRouter.models.length <= 1}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="model-add">
          <input
            placeholder="添加模型，如 anthropic/claude-sonnet-4"
            value={newModel}
            onChange={(event) => setNewModel(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && addModel()}
          />
          <button className="secondary" onClick={addModel} disabled={!newModel.trim()}>
            添加
          </button>
        </div>
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
