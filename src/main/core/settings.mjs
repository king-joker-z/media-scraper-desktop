import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { clampConcurrency, DEFAULT_CONCURRENCY } from './task-center.mjs'

export const DEFAULT_PROMPT_TEMPLATE = [
  '你是文件重命名助手。请根据以下信息为视频文件生成一个简洁、规范的新文件名：',
  '- 父文件夹名：{{parentFolder}}',
  '- 当前文件名（不含扩展名）：{{fileName}}',
  '- 扩展名：{{extension}}',
  '要求：只输出新文件名本身（不含扩展名），不要解释、不要引号、不要换行；',
  '保留有意义的标题信息，去除网站、广告、分辨率等噪音片段。'
].join('\n')

/** 内置 AI 平台预设（均为 OpenAI 兼容端点；baseUrl 可在设置页修改） */
export const PROVIDER_PRESETS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-chat', 'openai/gpt-5.6-luna']
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro']
  },
  {
    id: 'aicodemirror',
    name: 'AiCodeMirror',
    baseUrl: 'https://api.aicodemirror.ai/v1',
    models: []
  }
]

export const DEFAULT_SETTINGS = {
  concurrency: DEFAULT_CONCURRENCY,
  aiProviders: PROVIDER_PRESETS.map((preset) => ({
    ...preset,
    token: '',
    selectedModel: preset.models[0] ?? ''
  })),
  activeProviderId: 'openrouter',
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  regexTemplates: [
    { name: '去除 @ 尾巴', pattern: '@[^\\s@]+$', replacement: '', flags: 'g' },
    { name: '去除【】标签', pattern: '【[^】]*】', replacement: '', flags: 'g' },
    { name: '去除 [] 标签', pattern: '\\[[^\\]]*\\]', replacement: '', flags: 'g' }
  ]
}

const sanitizeModels = (models, fallback) =>
  Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m.trim()) : fallback

function normalizeProvider(raw, preset) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const models = sanitizeModels(input.models, preset?.models ?? [])
  return {
    id: input.id || preset?.id || `custom-${Date.now()}`,
    name:
      typeof input.name === 'string' && input.name.trim()
        ? input.name
        : (preset?.name ?? '自定义平台'),
    baseUrl:
      typeof input.baseUrl === 'string' && input.baseUrl.trim()
        ? input.baseUrl.trim().replace(/\/+$/, '')
        : (preset?.baseUrl ?? ''),
    token: typeof input.token === 'string' ? input.token : '',
    models,
    selectedModel: models.includes(input.selectedModel) ? input.selectedModel : (models[0] ?? '')
  }
}

/** 归一化外部输入：补默认值、收敛并发数、迁移旧版 openRouter 配置。 */
export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}

  let providers = Array.isArray(input.aiProviders) ? input.aiProviders : null
  // 旧版配置迁移：openRouter { token, models, selectedModel } → openrouter provider
  if (!providers && input.openRouter && typeof input.openRouter === 'object') {
    providers = PROVIDER_PRESETS.map((preset) =>
      preset.id === 'openrouter'
        ? {
            id: 'openrouter',
            name: preset.name,
            baseUrl: preset.baseUrl,
            token: typeof input.openRouter.token === 'string' ? input.openRouter.token : '',
            models: sanitizeModels(input.openRouter.models, preset.models),
            selectedModel: input.openRouter.selectedModel
          }
        : { ...preset, token: '', selectedModel: preset.models[0] ?? '' }
    )
  }
  const aiProviders = (providers ?? DEFAULT_SETTINGS.aiProviders).map((rawProvider) =>
    normalizeProvider(
      rawProvider,
      PROVIDER_PRESETS.find((p) => p.id === rawProvider?.id)
    )
  )
  const activeProviderId = aiProviders.some((p) => p.id === input.activeProviderId)
    ? input.activeProviderId
    : (aiProviders[0]?.id ?? 'openrouter')

  return {
    concurrency: clampConcurrency(input.concurrency ?? DEFAULT_SETTINGS.concurrency),
    aiProviders,
    activeProviderId,
    promptTemplate:
      typeof input.promptTemplate === 'string' && input.promptTemplate.trim()
        ? input.promptTemplate
        : DEFAULT_SETTINGS.promptTemplate,
    regexTemplates: Array.isArray(input.regexTemplates)
      ? input.regexTemplates.filter(
          (t) => t && typeof t.name === 'string' && typeof t.pattern === 'string'
        )
      : DEFAULT_SETTINGS.regexTemplates
  }
}

/** 取当前生效的 AI 平台配置 */
export function activeProvider(settings) {
  return (
    settings.aiProviders.find((p) => p.id === settings.activeProviderId) ?? settings.aiProviders[0]
  )
}

/** 轻量 JSON 设置存储：不依赖 Electron，构造时传入文件路径，便于测试。 */
export class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath
    this.cache = null
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      this.cache = normalizeSettings(JSON.parse(raw))
    } catch {
      this.cache = normalizeSettings(null)
    }
    return this.cache
  }

  async get() {
    return this.cache ?? (await this.load())
  }

  /** patch 为部分设置（aiProviders 整体替换），返回归一化后的完整设置。 */
  async update(patch) {
    const current = await this.get()
    this.cache = normalizeSettings({ ...current, ...patch })
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8')
    return this.cache
  }
}

export function createSettingsStore(filePath) {
  return new SettingsStore(filePath)
}
