import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { dirname } from 'node:path'
import { clampConcurrency, DEFAULT_CONCURRENCY } from './task-center.mjs'
import { writeAtomicTextFile } from './fs-ops.mjs'

export const DEFAULT_PROMPT_TEMPLATE =
  '根据文件名与父文件夹名称，提取原有作品标题并生成简洁、统一的本地媒体库名称。仅保留输入中能够直接确认的标题、集数或季数；去除网站名、上传者标记、推广语、无意义标签、分辨率、编码、码率、音轨、字幕和容器格式。不得根据题材、关键词或目录联想补写剧情、用途或描述；不得添加“未知影像”“生成影像”“一段”“片段”“记录”“视频”“文件”等输入中不存在的泛化词。信息不足时只清理原文件名并保留可确认内容，名称可短，不要为了凑字数编造。中文作品优先使用简体中文；原始名称明确为其他语言时才翻译为中文。不得包含扩展名、无意义长数字、“未命名”或“根目录”。'

export const DEFAULT_AI_BATCH_SIZE = 40
export const DEFAULT_AI_BATCH_CONCURRENCY = 3
export const DEFAULT_AI_REQUEST_TIMEOUT_SECONDS = 300
export const DEFAULT_AI_TEMPERATURE = 0.2
export const DEFAULT_AI_TOP_P = 1
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 0
const normalizeAiBatchSize = (value) => clampInteger(value, 1, 100, DEFAULT_AI_BATCH_SIZE)
const normalizeAiBatchConcurrency = (value) =>
  clampInteger(value, 1, 10, DEFAULT_AI_BATCH_CONCURRENCY)
const normalizeAiRequestTimeoutSeconds = (value) =>
  clampInteger(value, 5, 900, DEFAULT_AI_REQUEST_TIMEOUT_SECONDS)
const normalizeAiTemperature = (value) => clampNumber(value, 0, 2, DEFAULT_AI_TEMPERATURE)
const normalizeAiTopP = (value) => clampNumber(value, 0, 1, DEFAULT_AI_TOP_P)
const normalizeAiMaxOutputTokens = (value) =>
  clampInteger(value, 0, 32768, DEFAULT_AI_MAX_OUTPUT_TOKENS)

/** 内置 AI 平台预设：协议与扩展能力集中声明，避免 UI、IPC、请求层各自维护白名单。 */
export const PROVIDER_PRESETS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiProtocol: 'openai-chat',
    models: ['deepseek/deepseek-chat', 'openai/gpt-5.6-luna'],
    supportsThinking: false
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiProtocol: 'openai-chat',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    supportsThinking: true
  },
  {
    id: 'aicodemirror',
    name: 'AiCodeMirror',
    baseUrl: 'https://api.aicodemirror.ai/api/codex/backend-api/codex/v1',
    apiProtocol: 'openai-chat',
    models: ['gpt-5.6-luna'],
    supportsThinking: false
  },
  {
    id: 'linkai',
    name: 'LinkAI Direct',
    baseUrl: 'https://direct.linkai.pics/v1',
    apiProtocol: 'openai-chat',
    models: ['gpt-5.4-mini'],
    supportsThinking: true
  },
  {
    id: 'acucompute',
    name: 'AcuCompute',
    baseUrl: 'https://api.acucompute.com/v1',
    apiProtocol: 'openai-responses',
    // 平台模型会随账户套餐变化，预置控制台的自动路由；可在设置中按账户列表增删。
    models: ['acu-auto'],
    supportsThinking: true
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
  'comic-ukiyo',
  'pixel',
  'retro',
  'editorial',
  'glass',
  'y2k',
  'doodle',
  'aero',
  'swiss',
  'clay',
  'paper',
  'industrial',
  'nordic',
  'mecha',
  'nautical',
  'ink',
  'custom'
]
const DEFAULT_NVENC_ENABLED = process.platform === 'win32'
const DEFAULT_CURSOR_EFFECTS = process.platform === 'win32' ? 'off' : 'particles'
const DEFAULT_PERFORMANCE_MODE = process.platform === 'win32' ? 'reduced' : 'standard'
const DEFAULT_TASK_CONCURRENCY = process.platform === 'win32' ? 3 : DEFAULT_CONCURRENCY
export const DEFAULT_COMIC_BOOK_CONCURRENCY = process.platform === 'win32' ? 1 : 2
export const DEFAULT_COMIC_PAGE_CONCURRENCY = process.platform === 'win32' ? 2 : 4
export const MIN_COMIC_CONCURRENCY = 1
export const MAX_COMIC_BOOK_CONCURRENCY = 4
export const MAX_COMIC_PAGE_CONCURRENCY = 8

/** 最近工作区最多记忆条数 */
export const MAX_RECENT_WORKSPACES = 8

export const DEFAULT_SCAN_CONCURRENCY = process.platform === 'win32' ? 2 : 4
export const MIN_SCAN_CONCURRENCY = 1
export const MAX_SCAN_CONCURRENCY = 16

export const clampScanConcurrency = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SCAN_CONCURRENCY
  return Math.min(MAX_SCAN_CONCURRENCY, Math.max(MIN_SCAN_CONCURRENCY, Math.round(n)))
}
export const clampComicBookConcurrency = (value) =>
  clampInteger(
    value,
    MIN_COMIC_CONCURRENCY,
    MAX_COMIC_BOOK_CONCURRENCY,
    DEFAULT_COMIC_BOOK_CONCURRENCY
  )
export const clampComicPageConcurrency = (value) =>
  clampInteger(
    value,
    MIN_COMIC_CONCURRENCY,
    MAX_COMIC_PAGE_CONCURRENCY,
    DEFAULT_COMIC_PAGE_CONCURRENCY
  )

// 与 ffmpeg-pool.mjs 的默认池大小保持一致：按核数自适应（低配机 2，上限 4）。
export const DEFAULT_FFMPEG_POOL_SIZE =
  process.platform === 'win32' ? 2 : Math.min(4, Math.max(2, Math.floor(cpus().length / 2)))
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
  concurrency: DEFAULT_TASK_CONCURRENCY,
  comicBookConcurrency: DEFAULT_COMIC_BOOK_CONCURRENCY,
  comicPageConcurrency: DEFAULT_COMIC_PAGE_CONCURRENCY,
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
  // Windows 默认关闭全屏 Canvas；macOS 保持粒子效果。显式用户设置永远优先。
  cursorEffects: DEFAULT_CURSOR_EFFECTS,
  // Windows 合成器在大图、模糊与任务并发叠加时更易掉帧，新安装默认降低视觉效果。
  performanceMode: DEFAULT_PERFORMANCE_MODE,
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
    {
      name: '提取 @ 后标题',
      // 常见来源形如“域名@编号.标题”：删除前缀、编号和分隔点，只保留标题。
      pattern: '^.*@[^\\s@.]+\\.',
      replacement: '',
      flags: 'g'
    },
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

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
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
  // AcuCompute 内置平台最初误按 Chat Completions 配置；其 Codex 路由实际使用 Responses API。
  const isLegacyAcuCompute = input.id === 'acucompute' && input.apiProtocol === 'openai-chat'
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
    apiProtocol: isLegacyAcuCompute
      ? 'openai-responses'
      : [
            'openai-chat',
            'openai-responses',
            'anthropic-messages',
            'gemini-generate-content'
          ].includes(input.apiProtocol)
        ? input.apiProtocol
        : (preset?.apiProtocol ?? 'openai-chat'),
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
            requestTimeoutSeconds: normalizeAiRequestTimeoutSeconds(tuning?.requestTimeoutSeconds),
            // 保持历史配置兼容：此前没有开关时默认始终发送两个采样参数。
            temperatureEnabled: tuning?.temperatureEnabled !== false,
            temperature: normalizeAiTemperature(tuning?.temperature),
            topPEnabled: tuning?.topPEnabled !== false,
            topP: normalizeAiTopP(tuning?.topP),
            maxOutputTokens: normalizeAiMaxOutputTokens(tuning?.maxOutputTokens)
          }
        ])
    ),
    // 开关统一展示给全部平台；默认关闭，并且仅在用户主动开启时才发送扩展参数。
    supportsThinking: true,
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
  // 已取消内置的原生平台不再出现在标签栏；用户手动创建的平台仍完整保留。
  const retiredPresetIds = new Set(['hapi', 'anthropic', 'gemini', 'ollama'])
  const configuredProviders = (providers ?? DEFAULT_SETTINGS.aiProviders)
    .filter((rawProvider) => !retiredPresetIds.has(rawProvider?.id))
    .map((rawProvider) =>
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
    comicBookConcurrency: clampComicBookConcurrency(input.comicBookConcurrency),
    comicPageConcurrency: clampComicPageConcurrency(input.comicPageConcurrency),
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
    // 色板白名单是主进程唯一裁决点：UI 新增主题时必须同步登记，否则 IPC 会把它回退为海洋蓝。
    themePalette: THEME_PALETTE_OPTIONS.includes(input.themePalette)
      ? input.themePalette
      : DEFAULT_SETTINGS.themePalette,
    customAccent: normalizeCustomAccent(input.customAccent),
    backgroundAppearance: normalizeBackgroundAppearance(input.backgroundAppearance),
    cursorEffects: [
      'off',
      'particles',
      'ribbon',
      'sparkles',
      'comets',
      'confetti',
      'ripples'
    ].includes(input.cursorEffects)
      ? input.cursorEffects
      : DEFAULT_SETTINGS.cursorEffects,
    performanceMode:
      input.performanceMode === 'standard' || input.performanceMode === 'reduced'
        ? input.performanceMode
        : DEFAULT_SETTINGS.performanceMode,
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
      ? input.regexTemplates
          .filter((t) => t && typeof t.name === 'string' && typeof t.pattern === 'string')
          .map((t) =>
            // 升级历史默认规则：旧规则要么吞掉标题，要么只删编号而留下无意义前缀。
            (t.name === '去除 @ 尾巴' && t.pattern === '@[^\\s@]+$') ||
            (t.name === '去除 @ 标记' && t.pattern === '@[^\\s@.]+(?=\\.|$)')
              ? DEFAULT_SETTINGS.regexTemplates[0]
              : t
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
