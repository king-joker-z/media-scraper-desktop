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
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** 兼容 Retry-After 的秒数和 HTTP 日期格式；无效值由指数退避兜底。 */
export function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after')
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp - Date.now())
}

/** 按父目录边界构建批次；超出批大小的大目录再在目录内部拆分。 */
export function buildAiChunks(entries, batchSize) {
  const chunks = []
  const groups = new Map()
  for (const entry of entries) {
    const group = groups.get(entry.file.parentFolder) ?? []
    group.push(entry)
    groups.set(entry.file.parentFolder, group)
  }
  let current = []
  const flush = () => {
    if (current.length > 0) chunks.push(current)
    current = []
  }
  for (const group of groups.values()) {
    if (group.length > batchSize) {
      flush()
      for (let index = 0; index < group.length; index += batchSize) {
        chunks.push(group.slice(index, index + batchSize))
      }
    } else if (current.length + group.length > batchSize) {
      flush()
      current = [...group]
    } else {
      current.push(...group)
    }
  }
  flush()
  return chunks
}

/** 为 JSON 名称数组预留足够的输出长度，同时限制异常模型的冗长解释。 */
export function maxTokensForAiNames(itemCount) {
  return Math.min(8192, Math.max(256, itemCount * 128 + 128))
}

/** 将模型常见的非法输出规整为可落盘词干，拒绝空名、保留名和超长名称。 */
export function normalizeAiName(value) {
  const name = String(value ?? '')
    .split(ILLEGAL_NAME_RE)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(TRAILING_DOT_SPACE_RE, '')
    .trim()
  if (!name) throw new Error('AI 返回了空名称或仅包含非法字符')
  if (WINDOWS_RESERVED_NAME_RE.test(name)) {
    throw new Error(`AI 返回了 Windows 保留设备名「${name}」`)
  }
  if (name.length > MAX_STEM_LENGTH) {
    throw new Error(`AI 返回名称过长（>${MAX_STEM_LENGTH} 字符）`)
  }
  return name
}

/** HTTP 状态码 → 用户可懂的中文提示（U4：AI 命名失败提示友好化） */
const HTTP_HINTS = {
  400: '请求被平台拒绝（模型 ID 或参数可能不受支持）',
  401: 'Token 无效或已过期，请到设置页检查',
  402: '平台余额不足，请充值后重试',
  403: 'Token 权限不足或已被封禁',
  404: '接口地址或模型不存在，请检查设置页的 baseUrl 与模型 ID',
  429: '触发平台限流，请稍后重试或降低请求频率',
  502: '平台网关暂时异常，请稍后重试',
  503: '平台暂时不可用（可能维护或过载）；已自动重试，请稍后再试',
  504: '平台响应超时，请稍后重试'
}

/** 把 AI 平台失败响应转成可读错误（附平台返回摘要，便于排查） */
export async function toFriendlyHttpError(response) {
  const hint =
    HTTP_HINTS[response.status] ??
    (response.status >= 500 ? '平台服务故障，请稍后重试' : '请求失败')
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 200).trim()
  } catch {
    detail = ''
  }
  const head = `${hint}（HTTP ${response.status}）`
  return new Error(detail ? `${head}。平台返回：${detail}` : head)
}

/**
 * 带超时与指数退避重试的 fetch：
 * 网络错误/超时/5xx/429 重试（默认 2 次，1s → 2s），4xx 业务错误不重试。
 */
export async function fetchWithRetry(
  url,
  init,
  {
    fetchImpl = fetch,
    retries = 2,
    timeoutMs = AI_REQUEST_TIMEOUT_MS,
    retryDelayMs = 1000,
    signal,
    onRateLimit
  } = {}
) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw abortError()
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal
    try {
      const response = await fetchImpl(url, { ...init, signal: requestSignal })
      if (
        !response.ok &&
        (response.status >= 500 || response.status === 429) &&
        attempt < retries
      ) {
        const retryMs =
          response.status === 429
            ? Math.max(retryDelayMs * 2 ** attempt, retryAfterMs(response))
            : retryDelayMs * 2 ** attempt
        if (response.status === 429) onRateLimit?.(retryMs)
        await sleep(retryMs, signal)
        continue
      }
      return response
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw abortError()
      lastError = error
      if (attempt >= retries) break
      await sleep(retryDelayMs * 2 ** attempt, signal)
    }
  }
  throw new Error(
    `无法连接 AI 平台（已重试 ${retries} 次），请检查网络与设置页的 baseUrl：${lastError?.message ?? lastError}`
  )
}

/** 从文本中的指定起点读取一个完整 JSON 数组（字符串中的方括号不会误截断）。 */
function parseArrayAt(text, start) {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return JSON.parse(text.slice(start, index + 1))
    }
  }
  throw new Error('AI 返回中的 JSON 数组不完整')
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
  throw new Error('AI 返回中未找到有效 JSON 数组')
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

/** 从 OpenAI、Responses 与部分兼容服务的响应对象中提取模型文本与完成状态。 */
function responseDataToResult(data) {
  const choice = data?.choices?.[0]
  const message = choice?.message ?? {}
  const choiceContent = choice?.delta?.content ?? message.content ?? choice?.text
  const output = data?.output_text ?? data?.response?.output_text
  const gemini = data?.candidates?.[0]?.content?.parts
  return {
    content: contentToText(choiceContent) || contentToText(output) || contentToText(gemini),
    finishReason: choice?.finish_reason,
    // DeepSeek 思考模式会把 CoT 放在此字段；它不是最终名称，不能参与解析，仅用于诊断。
    hasReasoningContent: Boolean(choice?.delta?.reasoning_content ?? message.reasoning_content)
  }
}

const incompleteOutputError = (result) => {
  if (result?.finishReason === 'length') {
    return new Error('AI 输出被截断（达到 token 上限）；请关闭思考模式或降低每批文件数后重试')
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

const cacheKeyOf = (baseUrl, model, template, file) =>
  `${chatCompletionsUrl(baseUrl)}|${model}|${template}|${file.parentFolder}|${file.fileName}`

export function clearAiCache() {
  aiCache.clear()
}

/**
 * 请求 AI 平台（OpenAI 兼容端点）生成新文件名。
 * 命中会话缓存的文件不重复请求；仅对未命中的分批调用。
 * @param {object} options { baseUrl, token, model, template, files: AiFileInput[], fetchImpl?, onBatch?, useCache? }
 * useCache=false 用于用户主动重新生成：绕过旧结果，并在成功后刷新缓存。
 * @returns {Promise<string[]>} 与 files 等长的新词干数组
 */
export async function requestAiNames({
  baseUrl,
  token,
  model,
  template,
  thinkingEnabled,
  batchSize = AI_BATCH_SIZE,
  batchConcurrency = AI_BATCH_CONCURRENCY,
  requestTimeoutMs = AI_REQUEST_TIMEOUT_MS,
  files,
  fetchImpl = fetch,
  onBatch,
  useCache = true,
  retryDelayMs = 1000,
  signal
}) {
  if (!token) throw new Error('当前平台未配置 API Token，请先到设置页填写')
  if (!baseUrl) throw new Error('当前平台未配置 baseUrl')
  if (String(template ?? '').length > MAX_AI_PROMPT_LENGTH) {
    throw new Error(`AI 命名要求过长（最多 ${MAX_AI_PROMPT_LENGTH} 字符），请到设置页精简后重试`)
  }
  if (files.length === 0) return []

  // 缓存命中拆分；同一次请求中的相同输入只生成一次，再扇出回所有位置。
  const names = new Array(files.length)
  const missingByKey = new Map()
  let doneCount = 0
  files.forEach((file, index) => {
    const key = cacheKeyOf(baseUrl, model, template, file)
    const cached = useCache ? aiCache.get(key) : undefined
    if (cached !== undefined) {
      names[index] = cached
      doneCount += 1
      return
    }
    const entry = missingByKey.get(key)
    if (entry) entry.indexes.push(index)
    else missingByKey.set(key, { key, file, indexes: [index] })
  })
  const missing = [...missingByKey.values()]
  if (doneCount > 0) onBatch?.(doneCount)

  const safeBatchSize = clampInteger(batchSize, 1, 100, AI_BATCH_SIZE)
  const safeBatchConcurrency = clampInteger(batchConcurrency, 1, 10, AI_BATCH_CONCURRENCY)
  const safeRequestTimeoutMs = clampInteger(requestTimeoutMs, 5_000, 900_000, AI_REQUEST_TIMEOUT_MS)
  const chunks = buildAiChunks(missing, safeBatchSize)
  const failedChunks = []
  let cursor = 0
  let activeWorkers = 0
  let allowedConcurrency = safeBatchConcurrency
  let successfulBatches = 0
  let rateLimitUntil = 0

  const waitForRateLimit = async () => {
    const waitMs = rateLimitUntil - Date.now()
    if (waitMs > 0) await sleep(waitMs, signal)
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
    const response = await fetchWithRetry(
      chatCompletionsUrl(baseUrl),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/king-joker-z/media-scraper-desktop',
          'X-Title': 'Media Scraper'
        },
        body: JSON.stringify({
          model,
          messages: buildAiMessages(
            template,
            chunk.map((entry) => entry.file),
            { recovery }
          ),
          // DeepSeek 思考模式不支持 temperature；不传可避免第三方网关误处理该参数。
          ...(thinkingEnabled ? {} : { temperature: 0.2 }),
          max_tokens: maxTokensForAiNames(chunk.length),
          // 空结果恢复请求强制关闭思考，避免 CoT 耗尽轻量命名任务的输出预算。
          ...(typeof thinkingEnabled === 'boolean'
            ? {
                thinking: { type: recovery ? 'disabled' : thinkingEnabled ? 'enabled' : 'disabled' }
              }
            : {}),
          stream: false
        })
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
          const preview = String(responseContent).replaceAll(/\s+/g, ' ').slice(0, 160)
          const detail = preview ? `；返回片段：${preview}` : ''
          throw new Error(`AI 返回内容无法解析（不是有效的名称列表）：${error.message}${detail}`)
        }
      } else {
        const preview = String(responseContent).replaceAll(/\s+/g, ' ').slice(0, 160)
        const detail = preview ? `；返回片段：${preview}` : ''
        throw new Error(`AI 返回内容无法解析（不是有效的名称列表）：${error.message}${detail}`)
      }
    }
    if (chunkNames.length !== chunk.length) {
      throw new Error(`AI 返回数量（${chunkNames.length}）与请求数量（${chunk.length}）不一致`)
    }
    chunk.forEach((entry, chunkIndex) => {
      const name = normalizeAiName(chunkNames[chunkIndex])
      entry.indexes.forEach((index) => {
        names[index] = name
      })
      aiCache.set(entry.key, name)
    })
    doneCount += chunk.reduce((count, entry) => count + entry.indexes.length, 0)
    onBatch?.(doneCount)
    successfulBatches += 1
    if (successfulBatches >= AI_SUCCESSFUL_BATCHES_BEFORE_RAMP_UP) {
      allowedConcurrency = Math.min(safeBatchConcurrency, allowedConcurrency + 1)
      successfulBatches = 0
    }
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
              /AI 返回为空|仅返回了思考过程|达到 token 上限/.test(errorMessage(lastError))
            await requestChunk(chunk, { recovery })
            lastError = undefined
            break
          } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw abortError()
            lastError = error
          }
        }
        if (lastError) failedChunks.push({ chunk, error: lastError })
      } finally {
        activeWorkers -= 1
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(safeBatchConcurrency, chunks.length) }, worker))
  if (failedChunks.length > 0) {
    const failedCount = failedChunks.reduce(
      (count, { chunk }) => count + chunk.reduce((size, entry) => size + entry.indexes.length, 0),
      0
    )
    const detail = failedChunks
      .slice(0, 3)
      .map(({ error }) => (error instanceof Error ? error.message : String(error)))
      .join('；')
    throw new Error(`AI 命名有 ${failedCount} 项在局部重试后仍失败：${detail}`)
  }
  return names
}
