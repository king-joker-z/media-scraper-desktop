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

export const DEFAULT_SETTINGS = {
  concurrency: DEFAULT_CONCURRENCY,
  openRouter: {
    token: '',
    models: ['deepseek/deepseek-chat', 'openai/gpt-5.6-luna'],
    selectedModel: 'deepseek/deepseek-chat'
  },
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  regexTemplates: [
    { name: '去除 @ 尾巴', pattern: '@[^\\s@]+$', replacement: '', flags: 'g' },
    { name: '去除【】标签', pattern: '【[^】]*】', replacement: '', flags: 'g' },
    { name: '去除 [] 标签', pattern: '\\[[^\\]]*\\]', replacement: '', flags: 'g' }
  ]
}

/** 归一化外部输入：补默认值、收敛并发数、过滤非法字段。 */
export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const openRouterInput =
    input.openRouter && typeof input.openRouter === 'object' ? input.openRouter : {}
  const models = Array.isArray(openRouterInput.models)
    ? openRouterInput.models.filter((m) => typeof m === 'string' && m.trim())
    : DEFAULT_SETTINGS.openRouter.models
  const selectedModel =
    typeof openRouterInput.selectedModel === 'string' &&
    models.includes(openRouterInput.selectedModel)
      ? openRouterInput.selectedModel
      : (models[0] ?? '')
  return {
    concurrency: clampConcurrency(input.concurrency ?? DEFAULT_SETTINGS.concurrency),
    openRouter: {
      token: typeof openRouterInput.token === 'string' ? openRouterInput.token : '',
      models,
      selectedModel
    },
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

/**
 * 轻量 JSON 设置存储：不依赖 Electron，构造时传入文件路径，便于测试。
 */
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

  /** patch 为部分设置（支持嵌套 openRouter），返回归一化后的完整设置。 */
  async update(patch) {
    const current = await this.get()
    const merged = {
      ...current,
      ...patch,
      openRouter: { ...current.openRouter, ...(patch?.openRouter ?? {}) }
    }
    this.cache = normalizeSettings(merged)
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8')
    return this.cache
  }
}

export function createSettingsStore(filePath) {
  return new SettingsStore(filePath)
}
