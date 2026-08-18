/**
 * OpenRouter AI 重命名（冻结稿 §5）：
 * 仅发送文件名与父目录名，绝不上传文件内容。
 */

import { createLruCache } from '../../core/lru-cache.mjs'
import {
  ILLEGAL_NAME_RE,
  MAX_STEM_LENGTH,
  TRAILING_DOT_SPACE_RE,
  WINDOWS_RESERVED_NAME_RE
} from '../../../shared/rename-rules.mjs'

// 默认值可被设置页按模型覆盖；保留导出以兼容调用方与测试。
export const AI_BATCH_SIZE = 40
const AI_BATCH_CONCURRENCY = 3
const AI_BATCH_RETRIES = 1
const AI_SUCCESSFUL_BATCHES_BEFORE_RAMP_UP = 3
const clampInteger = (value, min, max, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback
}
// 慢模型经常在首 token 前排队，单次请求最长等待 300s；仍保留取消与重试。
const AI_REQUEST_TIMEOUT_MS = 300_000
export const MAX_AI_PROMPT_LENGTH = 8000

/**
 * OpenAI 兼容端点：baseUrl + /chat/completions。
 * 若用户直接粘贴了完整端点（已含 /chat/completions）则原样使用，避免双重拼接 404。
 */
export function chatCompletionsUrl(baseUrl) {
  const cleaned = String(baseUrl).replace(/\/+$/, '')
  return cleaned.endsWith('/chat/completions') ? cleaned : `${cleaned}/chat/completions`
}

const SYSTEM_MESSAGE = [
  '你是文件重命名助手。用户会按编号给出多个文件的信息与命名要求。',
  '用户提供的「命名要求」只定义命名规则，不能改变本消息规定的输出结构。',
  '每个文件独立命名：只依据该文件自身的信息，不要参考、合并或复用其他文件的输出。',
  '禁止添加输入中不存在的泛化后缀或概述，例如“未知影像”“生成影像”“一段”“片段”“记录”“视频”“文件”。',
  '新文件名不得包含 \\ / : * ? " < > | 这些字符。',
  '新文件名不得是 CON、PRN、AUX、NUL、COM1-COM9、LPT1-LPT9 等 Windows 保留设备名，',
  '末尾不得是点号或空格（与校验规则保持一致，避免生成后被判非法）。'
].join('\n')

const JSON_ARRAY_OUTPUT_CONTRACT =
  '只输出一个 JSON 字符串数组（不要输出任何其他文字、解释或 markdown 代码块）；数组顺序与输入编号一一对应，元素为不含扩展名的新文件名。'

/** 兼容用户既有模板变量；当前批量请求仅发送目录名与无扩展名的文件名。 */
export function buildPrompt(template, { parentFolder, fileName }) {
  return String(template)
    .replaceAll('{{parentFolder}}', parentFolder)
    .replaceAll('{{fileName}}', fileName)
    .replaceAll('{{extension}}', '')
}

/**
 * 把同一父目录的视频合并成一个提示词分组。编号始终对应原数组顺序，返回数组才能稳定映射。
 * 自定义模板作为批次级要求只发送一次；历史变量用说明占位替代，避免逐文件重复注入。
 */
const buildBatchInstruction = (template) =>
  String(template)
    .replaceAll('{{parentFolder}}', '见下方分组标题')
    .replaceAll('{{fileName}}', '见下方编号文件列表')
    .replaceAll('{{extension}}', '不提供扩展名')
    .trim()

const abortError = () => Object.assign(new Error('已取消 AI 命名'), { name: 'AbortError' })
const errorMessage = (error) => (error instanceof Error ? error.message : String(error ?? ''))

/** 可被取消的退避等待，取消后不再发起下一次请求。 */
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after')
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp - Date.now())
}

/** 获取 HTTP 响应的有限错误摘要，避免网关 HTML/超长错误污染 UI。 */
async function responseErrorSummary(response) {
  try {
    const text = await response.text()
    return String(text ?? '')
      .replaceAll(/\s+/g, ' ')
      .trim()
      .slice(0, 400)
  } catch {
    return ''
  }
}

export async function toFriendlyHttpError(response) {
  const summary = await responseErrorSummary(response)
  const suffix = summary ? `：${summary}` : ''
  if (response.status === 401 || response.status === 403)
    return new Error(`AI 平台鉴权失败（HTTP ${response.status}），请检查 API Token${suffix}`)
  if (response.status === 404) return new Error(`AI 接口地址或模型不存在${suffix}`)
  if (response.status === 429) return new Error(`AI 平台请求过于频繁，请稍后重试${suffix}`)
  if (response.status >= 500)
    return new Error(`AI 平台暂时不可用（HTTP ${response.status}）${suffix}`)
  return new Error(`AI 请求失败（HTTP ${response.status}）${suffix}`)
}

/** 带指数退避的 fetch；网络错误与 5xx 自动重试，AbortSignal 可随时停止。 */
export async function fetchWithRetry(
  url,
  options,
  {
    fetchImpl = fetch,
    retries = 2,
    retryDelayMs = 1000,
    timeoutMs = AI_REQUEST_TIMEOUT_MS,
    signal,
    onRateLimit
  } = {}
) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw abortError()
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs)
    const onAbort = () => timeoutController.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: timeoutController.signal
      })
      if (
        response.ok ||
        (response.status >= 400 && response.status < 500 && response.status !== 429)
      ) {
        return response
      }
      lastError = response
      if (response.status === 429) {
        const waitMs = retryAfterMs(response) || retryDelayMs * 2 ** attempt
        onRateLimit?.(waitMs)
        if (attempt < retries) await sleep(waitMs, signal)
      } else if (attempt < retries) {
        await sleep(retryDelayMs * 2 ** attempt, signal)
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        if (signal?.aborted) throw abortError()
        throw new Error(`AI 请求超时（${Math.round(timeoutMs / 1000)} 秒）`)
      }
      lastError = error
      if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt, signal)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  if (lastError instanceof Error) {
    throw new Error(`AI 请求失败，已重试 ${retries} 次：${lastError.message}`)
  }
  return lastError
}

/** 按父目录分组、在不超过批大小的前提下尽可能不拆分同目录文件。 */
export function buildAiChunks(entries, batchSize = AI_BATCH_SIZE) {
  const limit = clampInteger(batchSize, 1, 100, AI_BATCH_SIZE)
  const groups = []
  const byFolder = new Map()
  for (const entry of entries) {
    const folder = entry.file.parentFolder ?? ''
    if (!byFolder.has(folder)) {
      const group = []
      byFolder.set(folder, group)
      groups.push(group)
    }
    byFolder.get(folder).push(entry)
  }
  const chunks = []
  let current = []
  const flush = () => {
    if (current.length) chunks.push(current)
    current = []
  }
  for (const group of groups) {
    if (group.length > limit) {
      flush()
      for (let offset = 0; offset < group.length; offset += limit) {
        chunks.push(group.slice(offset, offset + limit))
      }
      continue
    }
    if (current.length + group.length > limit) flush()
    current.push(...group)
  }
  flush()
  return chunks
}

/** 计算批次所需输出 token；用户显式设置时尊重配置，否则按名称数量预留。 */
export function maxTokensForAiNames(itemCount, configuredMaxTokens = 0) {
  const configured = clampInteger(configuredMaxTokens, 0, 32768, 0)
  if (configured) return configured
  return Math.min(16384, Math.max(448, itemCount * 192 + 256))
}

/** 在文本中从指定位置读取完整 JSON 数组，支持名称中的方括号和转义字符。 */
function parseArrayAt(text, start) {
  let inString = false
  let escaped = false
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return JSON.parse(text.slice(start, index + 1))
    }
  }
  throw new Error('JSON 数组不完整')
}

/** 从模型输出中提取 JSON 名称数组，兼容代码块、包装对象与前后说明文本。 */
export function extractJsonArray(content) {
  const text = String(content ?? '').trim()
  if (!text) throw new Error('AI 返回为空')
  try {
    const whole = JSON.parse(text)
    if (Array.isArray(whole)) return whole
    if (whole && typeof whole === 'object') {
      for (const key of ['names', 'filenames', 'fileNames', 'results', 'items', 'data']) {
        if (Array.isArray(whole[key])) return whole[key]
      }
    }
  } catch {
    // 继续从混合文本中查找完整数组。
  }
  let searchFrom = 0
  while (searchFrom < text.length) {
    const start = text.indexOf('[', searchFrom)
    if (start === -1) break
    try {
      const parsed = parseArrayAt(text, start)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // 当前方括号可能是说明文字，继续查找下一个候选数组。
    }
    searchFrom = start + 1
  }
  throw new Error('AI 返回中未找到有效 JSON 数组（名称列表）')
}

/** 单条重生成的兜底：少数模型无视数组约束但直接给出标题时，安全地接受该标题。 */
export function extractSingleName(content) {
  const text = String(content ?? '')
    .trim()
    .replace(/^```(?:text|plaintext)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
    .replace(/^(?:新文件名|文件名|名称)\s*[:：]\s*/i, '')
  if (!text || /[\r\n]/.test(text) || text.length > MAX_STEM_LENGTH) {
    throw new Error('AI 单条返回不是可用的文件名')
  }
  return text.replace(/^['"“”]|['"“”]$/g, '').trim()
}

/** 将不同 OpenAI 兼容服务的 content（字符串、文本块数组等）统一为文本。 */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') return part.text ?? part.content ?? ''
        return ''
      })
      .join('')
  }
  return ''
}

/** 提取 OpenAI Responses API 的 output[].content[] 文本块。 */
function responsesOutputToText(output) {
  if (!Array.isArray(output)) return ''
  return output
    .filter((item) => item?.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part?.type === 'output_text')
    .map((part) => contentToText(part.text))
    .join('')
}

/** 从 OpenAI、Anthropic、Gemini 与常见兼容服务的响应对象中提取模型文本与完成状态。 */
function responseDataToResult(data) {
  const choice = data?.choices?.[0]
  const message = choice?.message ?? {}
  const choiceContent = choice?.delta?.content ?? message.content ?? choice?.text
  const output = data?.output_text ?? data?.response?.output_text
  const responsesOutput = data?.output ?? data?.response?.output
  const gemini = data?.candidates?.[0]?.content?.parts
  const anthropic = data?.content
  const toolCall =
    choice?.delta?.tool_calls ?? message.tool_calls ?? message.function_call ?? data?.tool_use
  return {
    content:
      contentToText(choiceContent) ||
      contentToText(output) ||
      responsesOutputToText(responsesOutput) ||
      contentToText(gemini) ||
      contentToText(anthropic),
    finishReason:
      choice?.finish_reason ??
      data?.stop_reason ??
      data?.candidates?.[0]?.finishReason ??
      data?.incomplete_details?.reason,
    hasToolCall: Boolean(toolCall),
    // DeepSeek 思考模式会把 CoT 放在此字段；它不是最终名称，不能参与解析，仅用于诊断。
    hasReasoningContent: Boolean(choice?.delta?.reasoning_content ?? message.reasoning_content)
  }
}

const incompleteOutputError = (result) => {
  if (result?.hasToolCall) {
    return new Error('AI 尝试调用工具而非直接输出名称，请关闭模型工具调用后重试')
  }
  if (['length', 'MAX_TOKENS', 'max_output_tokens', 'max_tokens'].includes(result?.finishReason)) {
    return new Error('AI 输出被截断（达到输出 token 上限）；请提高输出 token 预算后重试')
  }
  if (result?.hasReasoningContent) {
    return new Error('AI 仅返回了思考过程，未生成最终名称；请关闭思考模式后重试')
  }
  return new Error('AI 返回为空')
}

/**
 * 读取 OpenAI 兼容响应正文。部分平台即使没有请求流式模式，仍返回 SSE（`data: {...}`）；
 * 因此不能直接调用 response.json()。兼容普通 JSON、SSE、文本块数组及常见兼容字段。
 */
export async function readAiResponseContent(response) {
  // 响应流只能消费一次；统一读取 text 后解析，空响应直接给出明确错误。
  if (typeof response.text !== 'function') {
    const result = responseDataToResult(await response.json())
    if (!result.content) throw incompleteOutputError(result)
    return result.content
  }
  const raw = await response.text()
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('AI 返回为空')
  if (!trimmed.startsWith('data:')) {
    const result = responseDataToResult(JSON.parse(trimmed))
    if (!result.content) throw incompleteOutputError(result)
    return result.content
  }
  const parts = []
  let lastResult
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const result = responseDataToResult(JSON.parse(payload))
      lastResult = result
      if (result.content) parts.push(result.content)
    } catch {
      // SSE 心跳或非 JSON 扩展事件忽略，最终由空内容给出明确错误。
    }
  }
  const content = parts.join('')
  if (!content) throw incompleteOutputError(lastResult)
  return content
}

/** 构造批量请求消息：同目录只写一次目录名，单文件只发送名称。 */
export function buildAiMessages(template, files, { recovery = false } = {}) {
  const groups = new Map()
  files.forEach((file, index) => {
    const entries = groups.get(file.parentFolder) ?? []
    entries.push({ index, fileName: file.fileName })
    groups.set(file.parentFolder, entries)
  })
  const groupedFiles = [...groups]
    .map(([parentFolder, entries]) => {
      const first = entries[0].index + 1
      const last = entries.at(-1).index + 1
      const range = first === last ? `编号 ${first}` : `编号 ${first}–${last}`
      const list = entries.map(({ index, fileName }) => `${index + 1}. ${fileName}`).join('\n')
      return `父文件夹：${parentFolder}（${range}）\n${list}`
    })
    .join('\n\n')
  const instruction = buildBatchInstruction(template)
  const user = [
    instruction && `命名要求：${instruction}`,
    groupedFiles,
    `输出契约：${JSON_ARRAY_OUTPUT_CONTRACT}`,
    `必须恰好包含 ${files.length} 项，数组第 N 项对应编号 N。${
      files.length === 1
        ? '正确示例：["新文件名"]；禁止直接输出裸标题。'
        : '禁止输出编号、说明或任何额外文字。'
    }`,
    recovery &&
      '上一次响应没有产生可读取的最终答案。不要思考或解释，现在直接按输出契约给出完整 JSON 字符串数组。'
  ]
    .filter(Boolean)
    .join('\n\n')
  return [
    { role: 'system', content: SYSTEM_MESSAGE },
    { role: 'user', content: user }
  ]
}

/* ---------------- 会话级结果缓存：相同输入不重复请求 ---------------- */

// LRU 有界缓存（与探测/哈希缓存同策略）：防止长期使用后无界增长
const aiCache = createLruCache(5000)

const endpointUrl = (baseUrl, suffix) => {
  const cleaned = String(baseUrl).replace(/\/+$/, '')
  return cleaned.endsWith(suffix) ? cleaned : `${cleaned}${suffix}`
}

/** 为不同供应商协议构造请求；OpenRouter 专用归因头不再污染其它网关。 */
export function buildAiRequest({
  apiProtocol,
  baseUrl,
  token,
  model,
  messages,
  temperature,
  topP,
  maxOutputTokens,
  thinkingEnabled,
  omitSampling = false
}) {
  const system = messages.find((message) => message.role === 'system')?.content ?? ''
  const user = messages
    .filter((message) => message.role !== 'system')
    .map((message) => message.content)
    .join('\n\n')
  if (apiProtocol === 'anthropic-messages') {
    return {
      url: endpointUrl(baseUrl, '/messages'),
      headers: {
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: {
        model,
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: maxOutputTokens,
        temperature,
        top_p: topP
      }
    }
  }
  if (apiProtocol === 'gemini-generate-content') {
    return {
      url: `${endpointUrl(baseUrl, '')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(token)}`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature, topP, maxOutputTokens }
      }
    }
  }
  if (apiProtocol === 'openai-responses') {
    return {
      url: endpointUrl(baseUrl, '/responses'),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: {
        model,
        // 与 Responses API 的控制台示例一致：将系统规则与用户输入组合到 input，
        // 且不发送部分 Codex 路由拒绝的 temperature/top_p/thinking 扩展。
        input: [system, user].filter(Boolean).join('\n\n'),
        max_output_tokens: maxOutputTokens,
        stream: false
      }
    }
  }
  return {
    url: chatCompletionsUrl(baseUrl),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(String(baseUrl).includes('openrouter.ai')
        ? {
            'HTTP-Referer': 'https://github.com/king-joker-z/media-scraper-desktop',
            'X-Title': 'Media Scraper'
          }
        : {})
    },
    body: {
      model,
      messages,
      // DeepSeek 思考模式不支持 temperature；其它模型按用户调优参数发送。
      ...(thinkingEnabled || omitSampling ? {} : { temperature, top_p: topP }),
      max_tokens: maxOutputTokens,
      // 各家兼容网关对未知字段的容忍度不同，默认关闭时完全不发送 thinking。
      ...(thinkingEnabled === true ? { thinking: { type: 'enabled' } } : {}),
      stream: false
    }
  }
}

const cacheKeyOf = (baseUrl, model, template, protocol, thinkingEnabled, tuning, file) =>
  `${protocol}|${protocol === 'openai-responses' ? endpointUrl(baseUrl, '/responses') : chatCompletionsUrl(baseUrl)}|${model}|${template}|thinking:${thinkingEnabled === true}|` +
  `temperature:${tuning.temperature}|topP:${tuning.topP}|maxTokens:${tuning.maxOutputTokens}|` +
  `${file.parentFolder}|${file.fileName}`

export function clearAiCache() {
  aiCache.clear()
}

/**
 * 对单一模型发送一个极小的端到端请求，用于验证 URL、Token、模型 ID 和响应解析是否可用。
 * 不接入会话缓存，也不使用用户的批量命名模板，避免测试污染正式命名结果。
 */
export async function testAiConnection({
  baseUrl,
  token,
  model,
  apiProtocol = 'openai-chat',
  thinkingEnabled,
  requestTimeoutMs = 30_000,
  fetchImpl = fetch
}) {
  if (!token) throw new Error('当前平台未配置 API Token，请先填写后再测试')
  if (!baseUrl) throw new Error('当前平台未配置 baseUrl')
  if (!model) throw new Error('请先选择或添加一个模型后再测试')
  if (
    !['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate-content'].includes(
      apiProtocol
    )
  ) {
    throw new Error(`不支持的 AI 协议：${apiProtocol}`)
  }
  const messages = [
    { role: 'system', content: '你是连接测试助手。' },
    { role: 'user', content: '请只回复：连接成功' }
  ]
  const request = buildAiRequest({
    apiProtocol,
    baseUrl,
    token,
    model,
    messages,
    temperature: 0,
    topP: 1,
    // Responses/Codex 模型可能先消耗推理 token；32 会导致没有最终文本，保持与单文件命名相同的最低预算。
    maxOutputTokens: apiProtocol === 'openai-responses' ? maxTokensForAiNames(1) : 32,
    // 连通性测试遵循当前模型的开关，确保能验证用户实际会使用的请求参数。
    thinkingEnabled,
    omitSampling: thinkingEnabled === true
  })
  const startedAt = performance.now()
  const response = await fetchWithRetry(
    request.url,
    {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body)
    },
    {
      fetchImpl,
      retries: 0,
      timeoutMs: clampInteger(requestTimeoutMs, 5_000, 60_000, 30_000)
    }
  )
  if (!response.ok) throw await toFriendlyHttpError(response)
  const content = await readAiResponseContent(response)
  return {
    latencyMs: Math.round(performance.now() - startedAt),
    preview: String(content).replaceAll(/\s+/g, ' ').trim().slice(0, 120)
  }
}

/**
 * 请求 AI 平台（OpenAI 兼容端点）生成新文件名。
 * 命中会话缓存的文件不重复请求；仅对未命中的分批调用。
 * @param {object} options { baseUrl, token, model, apiProtocol, template, files: AiFileInput[], fetchImpl?, onBatch?, useCache? }
 * useCache=false 用于用户主动重新生成：绕过旧结果，并在成功后刷新缓存。
 * @returns {Promise<string[]>} 与 files 等长的新词干数组
 */
export async function requestAiNames({
  baseUrl,
  token,
  model,
  apiProtocol = 'openai-chat',
  template,
  thinkingEnabled,
  batchSize = AI_BATCH_SIZE,
  batchConcurrency = AI_BATCH_CONCURRENCY,
  requestTimeoutMs = AI_REQUEST_TIMEOUT_MS,
  temperature = 0.2,
  topP = 1,
  maxOutputTokens = 0,
  files,
  fetchImpl = fetch,
  onBatch,
  useCache = true,
  retryDelayMs = 1000,
  signal
}) {
  if (!token) throw new Error('当前平台未配置 API Token，请先到设置页填写')
  if (!baseUrl) throw new Error('当前平台未配置 baseUrl')
  if (
    !['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate-content'].includes(
      apiProtocol
    )
  ) {
    throw new Error(`不支持的 AI 协议：${apiProtocol}`)
  }
  if (String(template ?? '').length > MAX_AI_PROMPT_LENGTH) {
    throw new Error(`命名要求过长，请控制在 ${MAX_AI_PROMPT_LENGTH} 个字符以内`)
  }
  if (!Array.isArray(files) || files.length === 0) return []

  const safeBatchSize = clampInteger(batchSize, 1, 100, AI_BATCH_SIZE)
  const safeBatchConcurrency = clampInteger(batchConcurrency, 1, 10, AI_BATCH_CONCURRENCY)
  const safeRequestTimeoutMs = clampInteger(requestTimeoutMs, 5_000, 900_000, AI_REQUEST_TIMEOUT_MS)
  const safeTemperature = Number.isFinite(Number(temperature))
    ? Math.min(2, Math.max(0, Number(temperature)))
    : 0.2
  const safeTopP = Number.isFinite(Number(topP)) ? Math.min(1, Math.max(0, Number(topP))) : 1
  const safeMaxOutputTokens = clampInteger(maxOutputTokens, 0, 32768, 0)
  const entries = files.map((file, index) => ({ file, index }))
  const result = new Array(files.length)
  const pending = []
  for (const entry of entries) {
    const tuning = {
      temperature: safeTemperature,
      topP: safeTopP,
      maxOutputTokens: safeMaxOutputTokens
    }
    const key = cacheKeyOf(
      baseUrl,
      model,
      template,
      apiProtocol,
      thinkingEnabled,
      tuning,
      entry.file
    )
    const cached = useCache ? aiCache.get(key) : undefined
    if (cached) result[entry.index] = cached
    else pending.push(entry)
  }
  if (!pending.length) return result

  const chunks = buildAiChunks(pending, safeBatchSize)
  let cursor = 0
  let activeWorkers = 0
  let completed = result.filter(Boolean).length
  let allowedConcurrency = safeBatchConcurrency
  let successfulBatches = 0
  let rateLimitUntil = 0
  const waitForRateLimit = async () => {
    const delay = rateLimitUntil - Date.now()
    if (delay > 0) await sleep(delay, signal)
  }
  const takeChunk = async () => {
    while (true) {
      if (signal?.aborted) throw abortError()
      await waitForRateLimit()
      if (activeWorkers >= allowedConcurrency) {
        await sleep(25, signal)
        continue
      }
      if (cursor >= chunks.length) return undefined
      const chunk = chunks[cursor]
      cursor += 1
      activeWorkers += 1
      return chunk
    }
  }
  const onRateLimit = (retryMs) => {
    allowedConcurrency = Math.max(1, Math.ceil(allowedConcurrency / 2))
    rateLimitUntil = Math.max(rateLimitUntil, Date.now() + retryMs)
    successfulBatches = 0
  }
  const requestChunk = async (chunk, { recovery = false } = {}) => {
    const messages = buildAiMessages(
      template,
      chunk.map((entry) => entry.file),
      { recovery }
    )
    const request = buildAiRequest({
      apiProtocol,
      baseUrl,
      token,
      model,
      messages,
      temperature: safeTemperature,
      topP: safeTopP,
      maxOutputTokens: maxTokensForAiNames(chunk.length, safeMaxOutputTokens),
      thinkingEnabled: recovery ? undefined : thinkingEnabled,
      // 恢复请求不带思考扩展；原先开启时继续省略模型可能拒绝的采样参数。
      omitSampling: recovery && thinkingEnabled === true
    })
    const response = await fetchWithRetry(
      request.url,
      {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      },
      { fetchImpl, retryDelayMs, timeoutMs: safeRequestTimeoutMs, signal, onRateLimit }
    )
    if (!response.ok) throw await toFriendlyHttpError(response)
    const responseContent = await readAiResponseContent(response)
    let chunkNames
    try {
      chunkNames = extractJsonArray(responseContent)
    } catch (error) {
      if (chunk.length === 1) {
        try {
          chunkNames = [extractSingleName(responseContent)]
        } catch {
          throw error
        }
      } else {
        throw error
      }
    }
    if (chunkNames.length !== chunk.length) {
      throw new Error(`AI 返回数量不匹配：期望 ${chunk.length} 条，实际 ${chunkNames.length} 条`)
    }
    const normalized = chunkNames.map((name) => normalizeAiName(name))
    normalized.forEach((name, index) => {
      const entry = chunk[index]
      result[entry.index] = name
      const tuning = {
        temperature: safeTemperature,
        topP: safeTopP,
        maxOutputTokens: safeMaxOutputTokens
      }
      aiCache.set(
        cacheKeyOf(baseUrl, model, template, apiProtocol, thinkingEnabled, tuning, entry.file),
        name
      )
    })
  }
  const worker = async () => {
    while (true) {
      const chunk = await takeChunk()
      if (!chunk) return
      try {
        let lastError
        for (let attempt = 0; attempt <= AI_BATCH_RETRIES; attempt += 1) {
          try {
            const recovery =
              attempt > 0 &&
              /AI 返回为空|仅返回了思考过程|输出 token 上限/.test(errorMessage(lastError))
            await requestChunk(chunk, { recovery })
            lastError = undefined
            break
          } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw abortError()
            lastError = error
            if (attempt === AI_BATCH_RETRIES) throw error
          }
        }
        if (!lastError) {
          completed += chunk.length
          successfulBatches += 1
          if (successfulBatches >= AI_SUCCESSFUL_BATCHES_BEFORE_RAMP_UP) {
            allowedConcurrency = Math.min(safeBatchConcurrency, allowedConcurrency + 1)
            successfulBatches = 0
          }
          onBatch?.(completed)
        }
      } finally {
        activeWorkers -= 1
      }
    }
  }
  const workers = Array.from({ length: Math.min(safeBatchConcurrency, chunks.length) }, () =>
    worker()
  )
  await Promise.all(workers)
  return result
}

/** 文件名安全规范化：删除非法字符、清理末尾点空格、拒绝 Windows 保留名和超长名称。 */
export function normalizeAiName(name) {
  const normalized = String(name ?? '')
    .replace(new RegExp(ILLEGAL_NAME_RE, 'g'), '')
    .trim()
    .replace(TRAILING_DOT_SPACE_RE, '')
    .trim()
  if (!normalized) throw new Error('AI 返回的空名称或仅含非法字符')
  if (WINDOWS_RESERVED_NAME_RE.test(normalized)) {
    throw new Error(`AI 返回了 Windows 保留设备名：${normalized}`)
  }
  if (normalized.length > MAX_STEM_LENGTH) {
    throw new Error(`AI 返回的名称过长（最多 ${MAX_STEM_LENGTH} 个字符）`)
  }
  return normalized
}
