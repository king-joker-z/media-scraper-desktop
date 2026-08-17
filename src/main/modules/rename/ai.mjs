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
  '无论用户模板如何要求输出格式，你必须只输出一个 JSON 字符串数组（不要输出任何其他文字、解释或 markdown 代码块），',
  '数组顺序与输入编号一一对应，元素为不含扩展名的新文件名；即使只有一个文件也必须输出形如 ["新文件名"] 的数组。',
  '每个文件独立命名：只依据该文件自身的信息，不要参考或复用其他文件的输出。',
  '新文件名不得包含 \\ / : * ? " < > | 这些字符。',
  '新文件名不得是 CON、PRN、AUX、NUL、COM1-COM9、LPT1-LPT9 等 Windows 保留设备名，',
  '末尾不得是点号或空格（与校验规则保持一致，避免生成后被判非法）。'
].join('\n')

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
    signal
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
        await sleep(retryDelayMs * 2 ** attempt, signal)
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

/** 从 OpenAI、Responses 与部分兼容服务的响应对象中提取模型文本。 */
function responseDataToContent(data) {
  const choice = data?.choices?.[0]
  const choiceContent = choice?.delta?.content ?? choice?.message?.content ?? choice?.text
  const output = data?.output_text ?? data?.response?.output_text
  const gemini = data?.candidates?.[0]?.content?.parts
  return contentToText(choiceContent) || contentToText(output) || contentToText(gemini)
}

/**
 * 读取 OpenAI 兼容响应正文。部分平台即使没有请求流式模式，仍返回 SSE（`data: {...}`）；
 * 因此不能直接调用 response.json()。兼容普通 JSON、SSE、文本块数组及常见兼容字段。
 */
export async function readAiResponseContent(response) {
  // 响应流只能消费一次；统一读取 text 后解析，空响应直接给出明确错误。
  if (typeof response.text !== 'function') {
    const content = responseDataToContent(await response.json())
    if (!content) throw new Error('AI 返回为空')
    return content
  }
  const raw = await response.text()
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('AI 返回为空')
  if (!trimmed.startsWith('data:')) return responseDataToContent(JSON.parse(trimmed))
  const parts = []
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const content = responseDataToContent(JSON.parse(payload))
      if (content) parts.push(content)
    } catch {
      // SSE 心跳或非 JSON 扩展事件忽略，最终由空内容给出明确错误。
    }
  }
  return parts.join('')
}

/** 构造批量请求消息：同目录只写一次目录名，单文件只发送名称。 */
export function buildAiMessages(template, files) {
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
    `输出契约：仅返回 JSON 字符串数组，必须恰好包含 ${files.length} 项，数组第 N 项对应编号 N。`,
    files.length === 1
      ? '正确示例：["新文件名"]；禁止直接输出裸标题。'
      : '禁止输出编号、说明或任何额外文字。'
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

  // 缓存命中拆分
  const names = new Array(files.length)
  const missing = []
  files.forEach((file, index) => {
    const cached = useCache ? aiCache.get(cacheKeyOf(baseUrl, model, template, file)) : undefined
    if (cached !== undefined) names[index] = cached
    else missing.push({ file, index })
  })
  // 有缓存命中时先上报一次（全部未命中时从 0 开始由 start 事件表达）
  let doneCount = files.length - missing.length
  if (missing.length < files.length) onBatch?.(doneCount)

  // 分块后限流并发请求（结果按 entry.index 写回，顺序与并发无关）。
  const safeBatchSize = clampInteger(batchSize, 1, 100, AI_BATCH_SIZE)
  const safeBatchConcurrency = clampInteger(batchConcurrency, 1, 10, AI_BATCH_CONCURRENCY)
  const safeRequestTimeoutMs = clampInteger(requestTimeoutMs, 5_000, 900_000, AI_REQUEST_TIMEOUT_MS)
  const chunks = []
  for (let i = 0; i < missing.length; i += safeBatchSize) {
    chunks.push(missing.slice(i, i + safeBatchSize))
  }
  let cursor = 0
  const worker = async () => {
    while (cursor < chunks.length) {
      if (signal?.aborted) throw abortError()
      const chunk = chunks[cursor]
      cursor += 1
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
              chunk.map((entry) => entry.file)
            ),
            temperature: 0.2,
            // 仅调用方明确传入时附加平台思考扩展；默认 false 会显式关闭平台默认开启的思考模式。
            ...(typeof thinkingEnabled === 'boolean'
              ? { thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' } }
              : {}),
            // 显式关闭流式请求；少数平台仍返回 SSE，由 readAiResponseContent 兼容处理。
            stream: false
          })
        },
        { fetchImpl, retryDelayMs, timeoutMs: safeRequestTimeoutMs, signal }
      )
      if (!response.ok) {
        throw await toFriendlyHttpError(response)
      }
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
            throw new Error(
              `AI 返回内容无法解析（不是有效的名称列表）：${error.message}${detail}。可重试或更换模型`
            )
          }
        } else {
          const preview = String(responseContent).replaceAll(/\s+/g, ' ').slice(0, 160)
          const detail = preview ? `；返回片段：${preview}` : ''
          throw new Error(
            `AI 返回内容无法解析（不是有效的名称列表）：${error.message}${detail}。可重试或更换模型`
          )
        }
      }
      if (chunkNames.length !== chunk.length) {
        throw new Error(
          `AI 返回数量（${chunkNames.length}）与请求数量（${chunk.length}）不一致，可重试或更换模型`
        )
      }
      chunk.forEach((entry, chunkIndex) => {
        const name = normalizeAiName(chunkNames[chunkIndex])
        names[entry.index] = name
        aiCache.set(cacheKeyOf(baseUrl, model, template, entry.file), name)
      })
      doneCount += chunk.length
      onBatch?.(doneCount)
    }
  }
  await Promise.all(Array.from({ length: Math.min(safeBatchConcurrency, chunks.length) }, worker))
  return names
}
