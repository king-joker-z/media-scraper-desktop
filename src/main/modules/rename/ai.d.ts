declare module './ai.mjs' {
  import type { AiFileInput } from '../../../shared/types'

  export const AI_BATCH_SIZE: number
  export function chatCompletionsUrl(baseUrl: string): string
  export function buildPrompt(
    template: string,
    vars: { parentFolder: string; fileName: string; extension: string }
  ): string
  export function extractJsonArray(content: unknown): unknown[]
  /** 单条 AI 结果的纯文本标题兜底解析。 */
  export function extractSingleName(content: unknown): string
  /** 兼容普通 OpenAI JSON 与 SSE data: 响应，提取模型文本。 */
  export function readAiResponseContent(response: {
    text?: () => Promise<string>
    json: () => Promise<{
      choices?: { message?: { content?: string }; delta?: { content?: string } }[]
    }>
  }): Promise<string>
  export function buildAiMessages(
    template: string,
    files: AiFileInput[]
  ): { role: string; content: string }[]
  export function requestAiNames(options: {
    baseUrl: string
    token: string
    model: string
    template: string
    files: AiFileInput[]
    fetchImpl?: typeof fetch
    /** 每批完成回调：已完成数量 */
    onBatch?: (done: number) => void
    /** 默认 true：命中会话缓存的文件不重复请求 */
    useCache?: boolean
    /** 重试基础间隔 ms（指数退避），默认 1000 */
    retryDelayMs?: number
  }): Promise<string[]>
  export function clearAiCache(): void
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
    }
  ): Promise<Response>
}
