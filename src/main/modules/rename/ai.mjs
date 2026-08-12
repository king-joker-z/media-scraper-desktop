/**
 * OpenRouter AI 重命名（冻结稿 §5）：
 * 仅发送文件名与父目录名，绝不上传文件内容。
 */

import { createLruCache } from '../../core/lru-cache.mjs'

// 一次请求过大容易让兼容平台代理/模型在生成前超时；小批次可稳定处理上百个文件。
export const AI_BATCH_SIZE = 20
// 双并发显著缩短大批量等待时间，同时避免一次性创建大量 SSE/HTTP 连接触发限流。
const AI_BATCH_CONCURRENCY = 2
const AI_REQUEST_TIMEOUT_MS = 120_000

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

/** 模板变量替换（冻结稿：{{parentFolder}} {{fileName}} {{extension}}） */
export function buildPrompt(template, { parentFolder, fileName, extension }) {
  return String(template)
    .replaceAll('{{parentFolder}}', parentFolder)
    .replaceAll('{{fileName}}', fileName)
    .replaceAll('{{extension}}', extension)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** HTTP 状态码 → 用户可懂的中文提示（U4：AI 命名失败提示友好化） */
const HTTP_HINTS = {
  400: '请求被平台拒绝（模型 ID 或参数可能不受支持）',
  401: 'Token 无效或已过期，请到设置页检查',
  402: '平台余额不足，请充值后重试',
  403: 'Token 权限不足或已被封禁',
  404: '接口地址或模型不存在，请检查设置页的 baseUrl 与模型 ID',
  429: '触发平台限流，请稍后重试或降低请求频率'
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
  { fetchImpl = fetch, retries = 2, timeoutMs = AI_REQUEST_TIMEOUT_MS, retryDelayMs = 1000 } = {}
) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (
        !response.ok &&
        (response.status >= 500 || response.status === 429) &&
        attempt < retries
      ) {
        await sleep(retryDelayMs * 2 ** attempt)
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (attempt >= retries) break
      await sleep(retryDelayMs * 2 ** attempt)
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
  if (!text || /[\r\n]/.test(text) || text.length > 240) {
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
  const raw = typeof response.text === 'function' ? await response.text() : ''
  if (!raw) return responseDataToContent(await response.json())
  const trimmed = raw.trim()
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

/** 构造批量请求消息：每个文件一段编号描述 */
export function buildAiMessages(template, files) {
  const user = [
    files.map((file, index) => `${index + 1}. ${buildPrompt(template, file)}`).join('\n\n'),
    `\n输出契约：仅返回 JSON 字符串数组，必须恰好包含 ${files.length} 项。`,
    files.length === 1
      ? '正确示例：["新文件名"]；禁止直接输出裸标题。'
      : '禁止输出编号、说明或任何额外文字。'
  ].join('\n')
  return [
    { role: 'system', content: SYSTEM_MESSAGE },
    { role: 'user', content: user }
  ]
}

/* ---------------- 会话级结果缓存：相同输入不重复请求 ---------------- */

// LRU 有界缓存（与探测/哈希缓存同策略）：防止长期使用后无界增长
const aiCache = createLruCache(5000)

const cacheKeyOf = (baseUrl, model, template, file) =>
  `${chatCompletionsUrl(baseUrl)}|${model}|${template}|${file.parentFolder}|${file.fileName}|${file.extension}`

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
  files,
  fetchImpl = fetch,
  onBatch,
  useCache = true,
  retryDelayMs = 1000
}) {
  if (!token) throw new Error('当前平台未配置 API Token，请先到设置页填写')
  if (!baseUrl) throw new Error('当前平台未配置 baseUrl')
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

  // 分块后限流并发请求（结果按 entry.index 写回，顺序与并发无关）
  const chunks = []
  for (let i = 0; i < missing.length; i += AI_BATCH_SIZE) {
    chunks.push(missing.slice(i, i + AI_BATCH_SIZE))
  }
  let cursor = 0
  const worker = async () => {
    while (cursor < chunks.length) {
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
            // 显式关闭流式请求；少数平台仍返回 SSE，由 readAiResponseContent 兼容处理。
            stream: false
          })
        },
        { fetchImpl, retryDelayMs, timeoutMs: AI_REQUEST_TIMEOUT_MS }
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
        const name = String(chunkNames[chunkIndex]).trim()
        names[entry.index] = name
        aiCache.set(cacheKeyOf(baseUrl, model, template, entry.file), name)
      })
      doneCount += chunk.length
      onBatch?.(doneCount)
    }
  }
  await Promise.all(Array.from({ length: Math.min(AI_BATCH_CONCURRENCY, chunks.length) }, worker))
  return names
}
