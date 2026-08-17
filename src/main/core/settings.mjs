import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { clampConcurrency, DEFAULT_CONCURRENCY } from './task-center.mjs'
import { writeAtomicTextFile } from './fs-ops.mjs'

export const DEFAULT_PROMPT_TEMPLATE =
  '根据文件名生成简洁、规范的新名称；保留有意义的标题，去除网站、广告、分辨率等噪音。'

export const DEFAULT_AI_BATCH_SIZE = 40
export const DEFAULT_AI_BATCH_CONCURRENCY = 3
export const DEFAULT_AI_REQUEST_TIMEOUT_SECONDS = 300
const normalizeAiBatchSize = (value) => clampInteger(value, 1, 100, DEFAULT_AI_BATCH_SIZE)
const normalizeAiBatchConcurrency = (value) =>
  clampInteger(value, 1, 10, DEFAULT_AI_BATCH_CONCURRENCY)
const normalizeAiRequestTimeoutSeconds = (value) =>
  clampInteger(value, 5, 900, DEFAULT_AI_REQUEST_TIMEOUT_SECONDS)

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
    baseUrl: 'https://api.aicodemirror.ai/api/codex/backend-api/codex/v1',
    models: ['gpt-5.6-luna']
  },
  {
    id: 'linkai',
    name: 'LinkAI Direct',
    baseUrl: 'https://direct.linkai.pics/v1',
    models: ['gpt-5.4-mini']
  },
  {
    id: 'hapi',
    name: 'HAPI Open',
    baseUrl: 'https://hapiopen.cc/v1',
    models: ['gpt-5.4-mini']
  }
]

export const THEME_OPTIONS = ['system', 'light', 'dark']
export const THEME_PALETTE_OPTIONS = [
  'ocean',
  'violet',
  'forest',
  'sunset',
  'graphite',
  'berry',
  'amber',
  'jade',
  'sky',
  'mint',
  'lemon',
  'rose',
  'comic',
  'pixel',
  'retro',
  'editorial',
  'custom'
]
const DEFAULT_NVENC_ENABLED = process.platform === 'win32'

/** 最近工作区最多记忆条数 */
export const MAX_RECENT_WORKSPACES = 8

export const DEFAULT_SCAN_CONCURRENCY = 4
export const MIN_SCAN_CONCURRENCY = 1
export const MAX_SCAN_CONCURRENCY = 16

export const clampScanConcurrency = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SCAN_CONCURRENCY
  return Math.min(MAX_SCAN_CONCURRENCY, Math.max(MIN_SCAN_CONCURRENCY, Math.round(n)))
}

export const DEFAULT_FFMPEG_POOL_SIZE = 4
export const MIN_FFMPEG_POOL_SIZE = 1
export const MAX_FFMPEG_POOL_SIZE = 8

export const clampFfmpegPoolSize = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_FFMPEG_POOL_SIZE
  return Math.min(MAX_FFMPEG_POOL_SIZE, Math.max(MIN_FFMPEG_POOL_SIZE, Math.round(n)))
}

const clampMergeTranscodeConcurrency = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(4, Math.max(1, Math.round(n)))
}

const normalizeMergeTempLocation = (value) =>
  ['source-disk', 'system', 'custom'].includes(value) ? value : 'source-disk'

export const DEFAULT_SETTINGS = {
  concurrency: DEFAULT_CONCURRENCY,
  scanConcurrency: DEFAULT_SCAN_CONCURRENCY,
  ffmpegPoolSize: DEFAULT_FFMPEG_POOL_SIZE,
  nvencEnabled: DEFAULT_NVENC_ENABLED,
  cudaPipelineEnabled: false,
  mergeTranscodeConcurrency: 1,
  mergeTempLocation: 'source-disk',
  mergeTempCustomPath: '',
  theme: 'system',
  themePalette: 'ocean',
  customAccent: '#1687d9',
  backgroundAppearance: {
    imagePath: '',
    imageOpacity: 32,
    blur: 8,
    surfaceOpacity: 35,
    fit: 'cover'
  },
  libraryDensity: 'standard',
  aiProviders: PROVIDER_PRESETS.map((preset) => ({
    ...preset,
    token: '',
    selectedModel: preset.models[0] ?? '',
    // DeepSeek 默认关闭思考模式，避免轻量命名任务产生不必要的推理等待。
    thinkingEnabled: false
  })),
  activeProviderId: 'openrouter',
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  regexTemplates: [
    { name: '去除 @ 尾巴', pattern: '@[^\\s@]+$', replacement: '', flags: 'g' },
    { name: '去除【】标签', pattern: '【[^】]*】', replacement: '', flags: 'g' },
    { name: '去除 [] 标签', pattern: '\\[[^\\]]*\\]', replacement: '', flags: 'g' }
  ],
  recentWorkspaces: [],
  // 漫画模块（与视频工作区独立）：默认进入模块选择页
  activeModule: null,
  comicWorkspace: '',
  comicRecentWorkspaces: [],
  comicFormat: 'epub',
  deleteToTrash: true
}

/** 把新工作区提到最近列表首位（去重、截断） */
export function pushRecentWorkspace(list, workspace) {
  const rest = (Array.isArray(list) ? list : []).filter((item) => item !== workspace)
  return [workspace, ...rest].slice(0, MAX_RECENT_WORKSPACES)
}

const sanitizeModels = (models, fallback) =>
  Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m.trim()) : fallback

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

const normalizeCustomAccent = (value) =>
  typeof value === 'string' && HEX_COLOR_PATTERN.test(value)
    ? value.toLowerCase()
    : DEFAULT_SETTINGS.customAccent

const clampInteger = (value, min, max, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback
}

const normalizeBackgroundAppearance = (value) => {
  const input = value && typeof value === 'object' ? value : {}
  return {
    imagePath: typeof input.imagePath === 'string' ? input.imagePath : '',
    imageOpacity: clampInteger(
      input.imageOpacity,
      0,
      100,
      DEFAULT_SETTINGS.backgroundAppearance.imageOpacity
    ),
    blur: clampInteger(input.blur, 0, 32, DEFAULT_SETTINGS.backgroundAppearance.blur),
    surfaceOpacity: clampInteger(
      input.surfaceOpacity,
      0,
      100,
      DEFAULT_SETTINGS.backgroundAppearance.surfaceOpacity
    ),
    fit: input.fit === 'contain' ? 'contain' : 'cover'
  }
}

function normalizeProvider(raw, preset) {
  const input = raw && typeof raw === 'object' ? raw : {}
  // LinkAI 原预设域名升级为 Direct 网关；仅迁移旧默认值，不覆盖用户自定义地址。
  const isLegacyLinkAi =
    input.id === 'linkai' && String(input.baseUrl).replace(/\/+$/, '') === 'https://linkai.pics/v1'
  const baseUrlInput = isLegacyLinkAi ? 'https://direct.linkai.pics/v1' : input.baseUrl
  const models =
    isLegacyLinkAi && Array.isArray(input.models) && input.models.join() === 'linkai-auto'
      ? ['gpt-5.4-mini']
      : sanitizeModels(input.models, preset?.models ?? [])
  return {
    id: input.id || preset?.id || `custom-${Date.now()}`,
    name:
      isLegacyLinkAi && input.name === 'LinkAI'
        ? 'LinkAI Direct'
        : typeof input.name === 'string' && input.name.trim()
          ? input.name
          : (preset?.name ?? '自定义平台'),
    baseUrl:
      typeof baseUrlInput === 'string' && baseUrlInput.trim()
        ? baseUrlInput.trim().replace(/\/+$/, '')
        : (preset?.baseUrl ?? ''),
    token: typeof input.token === 'string' ? input.token : '',
    models,
    selectedModel: models.includes(input.selectedModel) ? input.selectedModel : (models[0] ?? ''),
    modelTunings: Object.fromEntries(
      Object.entries(
        input.modelTunings && typeof input.modelTunings === 'object' ? input.modelTunings : {}
      )
        .filter(([model]) => models.includes(model))
        .map(([model, tuning]) => [
          model,
          {
            batchSize: normalizeAiBatchSize(tuning?.batchSize),
            concurrency: normalizeAiBatchConcurrency(tuning?.concurrency),
            requestTimeoutSeconds: normalizeAiRequestTimeoutSeconds(tuning?.requestTimeoutSeconds)
          }
        ])
    ),
    // DeepSeek 与 LinkAI Direct 平台在请求中读取此开关；旧配置缺失时默认关闭。
    thinkingEnabled: input.thinkingEnabled === true
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
        : {
            ...preset,
            token: '',
            selectedModel: preset.models[0] ?? '',
            thinkingEnabled: false
          }
    )
  }
  const configuredProviders = (providers ?? DEFAULT_SETTINGS.aiProviders).map((rawProvider) =>
    normalizeProvider(
      rawProvider,
      PROVIDER_PRESETS.find((p) => p.id === rawProvider?.id)
    )
  )
  // 升级后补齐新内置平台，保留用户已有的平台顺序与自定义平台。
  const aiProviders = [
    ...configuredProviders,
    ...PROVIDER_PRESETS.filter(
      (preset) => !configuredProviders.some((provider) => provider.id === preset.id)
    ).map((preset) => normalizeProvider(preset, preset))
  ]
  const activeProviderId = aiProviders.some((p) => p.id === input.activeProviderId)
    ? input.activeProviderId
    : (aiProviders[0]?.id ?? 'openrouter')

  return {
    concurrency: clampConcurrency(input.concurrency ?? DEFAULT_SETTINGS.concurrency),
    scanConcurrency: clampScanConcurrency(
      input.scanConcurrency ?? DEFAULT_SETTINGS.scanConcurrency
    ),
    ffmpegPoolSize: clampFfmpegPoolSize(input.ffmpegPoolSize ?? DEFAULT_SETTINGS.ffmpegPoolSize),
    // 兼容上一版本的三态编码器设置：仅显式 cpu 等价于关闭；其余模式跟随平台默认。
    nvencEnabled:
      typeof input.nvencEnabled === 'boolean'
        ? input.nvencEnabled
        : input.videoEncoder === 'cpu'
          ? false
          : DEFAULT_SETTINGS.nvencEnabled,
    cudaPipelineEnabled: input.cudaPipelineEnabled === true,
    mergeTranscodeConcurrency: clampMergeTranscodeConcurrency(input.mergeTranscodeConcurrency),
    mergeTempLocation: normalizeMergeTempLocation(input.mergeTempLocation),
    mergeTempCustomPath:
      typeof input.mergeTempCustomPath === 'string' ? input.mergeTempCustomPath.trim() : '',
    theme: THEME_OPTIONS.includes(input.theme) ? input.theme : DEFAULT_SETTINGS.theme,
    themePalette: THEME_PALETTE_OPTIONS.includes(input.themePalette)
      ? input.themePalette
      : DEFAULT_SETTINGS.themePalette,
    customAccent: normalizeCustomAccent(input.customAccent),
    backgroundAppearance: normalizeBackgroundAppearance(input.backgroundAppearance),
    libraryDensity: ['comfortable', 'standard', 'compact'].includes(input.libraryDensity)
      ? input.libraryDensity
      : DEFAULT_SETTINGS.libraryDensity,
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
      : DEFAULT_SETTINGS.regexTemplates,
    recentWorkspaces: Array.isArray(input.recentWorkspaces)
      ? input.recentWorkspaces
          .filter((p) => typeof p === 'string' && p.trim())
          .slice(0, MAX_RECENT_WORKSPACES)
      : [],
    activeModule: ['video', 'comic'].includes(input.activeModule) ? input.activeModule : null,
    comicWorkspace: typeof input.comicWorkspace === 'string' ? input.comicWorkspace : '',
    comicRecentWorkspaces: Array.isArray(input.comicRecentWorkspaces)
      ? input.comicRecentWorkspaces
          .filter((p) => typeof p === 'string' && p.trim())
          .slice(0, MAX_RECENT_WORKSPACES)
      : [],
    comicFormat: input.comicFormat === 'pdf' ? 'pdf' : 'epub',
    deleteToTrash: input.deleteToTrash !== false
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
    // update 串行化队列：并发 update（如 StrictMode 双调用恢复工作区）共享同一
    // .tmp 路径会互相踩踏（rename 时 tmp 已消失），排队后逐一落盘
    this.writeQueue = Promise.resolve()
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      this.cache = normalizeSettings(JSON.parse(raw))
    } catch {
      // 主文件损坏/缺失时尝试 .bak 备份（例如上次写入中途崩溃），避免 token 等配置全丢
      try {
        const backup = await readFile(`${this.filePath}.bak`, 'utf8')
        this.cache = normalizeSettings(JSON.parse(backup))
      } catch {
        this.cache = normalizeSettings(null)
      }
    }
    return this.cache
  }

  async get() {
    return this.cache ?? (await this.load())
  }

  /** patch 为部分设置（aiProviders 整体替换），返回归一化后的完整设置。 */
  update(patch) {
    const next = this.writeQueue.then(() => this.doUpdate(patch))
    this.writeQueue = next.catch(() => {})
    return next
  }

  async doUpdate(patch) {
    const current = await this.get()
    this.cache = normalizeSettings({ ...current, ...patch })
    await mkdir(dirname(this.filePath), { recursive: true })
    // 原子写入：先写临时文件，备份旧文件后 rename 替换，防止写一半留坏档
    // 先写可校验 JSON，再保留上一份备份，最后经 fs-ops 的 Windows 安全替换提交。
    const serialized = JSON.stringify(this.cache, null, 2)
    JSON.parse(serialized)
    try {
      await copyFile(this.filePath, `${this.filePath}.bak`)
    } catch {
      // 首次写入没有旧文件，忽略
    }
    await writeAtomicTextFile(this.filePath, serialized)
    return this.cache
  }
}

export function createSettingsStore(filePath) {
  return new SettingsStore(filePath)
}
