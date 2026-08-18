declare module './ai.mjs' {
  import type { AiFileInput } from '../../../shared/types'

  export const AI_BATCH_SIZE: number
  export const MAX_AI_PROMPT_LENGTH: number
  export const MAX_AI_FILES_PER_REQUEST: number
  export const MAX_AI_FILE_FIELD_LENGTH: number
  export const MAX_AI_BATCH_PROMPT_LENGTH: number
  export function retryAfterMs(response: { headers?: { get(name: string): string | null } }): number
  export function maxTokensForAiNames(itemCount: number, configuredMaxTokens?: number): number
  export function buildAiRequest(options: {
    apiProtocol:
      'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-generate-content'
    baseUrl: string
    token: string
    model: string
    messages: { role: string; content: string }[]
    temperature: number
    topP: number
    temperatureEnabled?: boolean
    topPEnabled?: boolean
    maxOutputTokens: number
    thinkingEnabled?: boolean
    omitSampling?: boolean
  }): { url: string; headers: Record<string, string>; body: Record<string, unknown> }
  export function buildAiChunks<T extends { file: AiFileInput }>(
    entries: T[],
    batchSize: number
  ): T[][]
  export function chatCompletionsUrl(baseUrl: string): string
  export function buildPrompt(
    template: string,
    vars: { parentFolder: string; fileName: string }
  ): string
  export function extractJsonArray(content: unknown): unknown[]
  /** 单条 AI 结果的纯文本标题兜底解析。 */
  export function extractSingleName(content: unknown): string
  /** 将 AI 返回名称规范化为可跨平台落盘的词干。 */
  export function normalizeAiName(content: unknown): string
  /** 兼容普通 OpenAI JSON 与 SSE data: 响应，提取模型文本。 */
  export function readAiResponseContent(response: {
    text?: () => Promise<string>
    json: () => Promise<unknown>
  }): Promise<string>
  export function buildAiMessages(
    template: string,
    files: AiFileInput[],
    options?: { recovery?: boolean }
  ): { role: string; content: string }[]
  export function requestAiNames(options: {
    baseUrl: string
    token: string
    model: string
    /** API 协议，默认 OpenAI Chat Completions。 */
    apiProtocol?:
      'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-generate-content'
    template: string
    /** 仅支持的平台传递思考模式开关；未传时不附加平台扩展参数。 */
    thinkingEnabled?: boolean
    /** 每批请求项数（1–100），默认 40。 */
    batchSize?: number
    /** 同时请求数（1–10），默认 3。 */
    batchConcurrency?: number
    /** 单次请求超时毫秒数（5_000–900_000），默认 300_000。 */
    requestTimeoutMs?: number
    /** 采样温度（0–2），默认 0.2。 */
    temperature?: number
    /** 核采样（0–1），默认 1。 */
    topP?: number
    /** 是否发送 temperature，默认 true。 */
    temperatureEnabled?: boolean
    /** 是否发送 top_p，默认 true。 */
    topPEnabled?: boolean
    /** 最大输出 token（0–32768）；0 为随批大小自动计算。 */
    maxOutputTokens?: number
    files: AiFileInput[]
    fetchImpl?: typeof fetch
    /** 每批完成回调：已完成数量 */
    onBatch?: (done: number) => void
    /** 默认 true：命中会话缓存的文件不重复请求 */
    useCache?: boolean
    /** 重试基础间隔 ms（指数退避），默认 1000 */
    retryDelayMs?: number
    /** 外部取消信号；取消会中止在途请求和退避等待 */
    signal?: AbortSignal
  }): Promise<string[]>
  export function clearAiCache(): void
  /** 向指定单一模型发送最小请求，验证端点、鉴权、模型 ID 与响应解析。 */
  export function testAiConnection(options: {
    baseUrl: string
    token: string
    model: string
    apiProtocol?:
      'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-generate-content'
    thinkingEnabled?: boolean
    /** 采样温度（0–2），默认 0.2。 */
    temperature?: number
    /** 核采样（0–1），默认 1。 */
    topP?: number
    /** 是否发送 temperature，默认 true。 */
    temperatureEnabled?: boolean
    /** 是否发送 top_p，默认 true。 */
    topPEnabled?: boolean
    requestTimeoutMs?: number
    fetchImpl?: typeof fetch
  }): Promise<{ latencyMs: number; preview: string }>
  /** 把 AI 平台失败响应转成可读中文错误（附平台返回摘要） */
  export function toFriendlyHttpError(response: {
    status: number
    text: () => Promise<string>
  }): Promise<Error>
  export function fetchWithRetry(
    url: string,
    init: RequestInit,
    options?: {
      fetchImpl?: typeof fetch
      retries?: number
      timeoutMs?: number
      retryDelayMs?: number
      signal?: AbortSignal
      /** 收到 429 时通知实际等待时间（含 Retry-After）。 */
      onRateLimit?: (retryMs: number) => void
    }
  ): Promise<Response>
}
