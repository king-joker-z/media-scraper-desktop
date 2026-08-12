/**
 * OpenRouter AI 重命名（冻结稿 §5）：
 * 仅发送文件名与父目录名，绝不上传文件内容。
 */

import { createLruCache } from '../../core/lru-cache.mjs'

// 一次请求过大容易让兼容平台代理/模型在生成前超时；小批次可稳定处理上百个文件。
export const AI_BATCH_SIZE = 20
// 许多兼容服务对同一 Token 的并发 SSE 请求不稳定，串行配合缓存和进度反馈更可靠。
const AI_BATCH_CONCURRENCY = 1
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
  '你必须只输出一个 JSON 字符串数组（不要输出任何其他文字、解释或 markdown 代码块），',
  '数组顺序与输入编号一一对应，元素为不含扩展名的新文件名。',
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

/** 从模型输出中提取 JSON 数组（容忍 markdown 代码块与前后杂文本） */
export function extractJsonArray(content) {
  const text = String(content ?? '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI 返回中未找到 JSON 数组')
  }
  const parsed = JSON.parse(text.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('AI 返回不是数组')
  return parsed
}

/**
 * 读取 OpenAI 兼容响应正文。部分平台即使没有请求流式模式，仍返回 SSE（`data: {...}`）；
 * 因此不能直接调用 response.json()。兼容普通 JSON、SSE 的 message 内容和 delta 内容。
 */
export async function readAiResponseContent(response) {
  const raw = typeof response.text === 'function' ? await response.text() : ''
  if (!raw) {
    const data = await response.json()
    return data?.choices?.[0]?.message?.content ?? ''
  }
  const trimmed = raw.trim()
  if (!trimmed.startsWith('data:')) {
    const data = JSON.parse(trimmed)
    return data?.choices?.[0]?.message?.content ?? ''
  }
  const parts = []
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const event = JSON.parse(payload)
      const content = event?.choices?.[0]?.delta?.content ?? event?.choices?.[0]?.message?.content
      if (typeof content === 'string') parts.push(content)
    } catch {
      // SSE 心跳或非 JSON 扩展事件忽略，最终由空内容给出明确错误。
    }
  }
  return parts.join('')
}

/** 构造批量请求消息：每个文件一段编号描述 */
export function buildAiMessages(template, files) {
  const user = files
    .map((file, index) => `${index + 1}. ${buildPrompt(template, file)}`)
    .join('\n\n')
  return [
    { role: 'system', content: SYSTEM_MESSAGE },
    { role: 'user', content: user }
  ]
}

/* ---------------- 会话级结果缓存：相同输入不重复请求 ---------------- */

// LRU 有界缓存（与探测/哈希缓存同策略）：防止长期使用后无界增长
const aiCache = createLruCache(5000)

const cacheKeyOf = (model, template, file) =>
  `${model}|${template}|${file.parentFolder}|${file.fileName}|${file.extension}`

export function clearAiCache() {
  aiCache.clear()
}

/**
 * 请求 AI 平台（OpenAI 兼容端点）生成新文件名。
 * 命中会话缓存的文件不重复请求；仅对未命中的分批调用。
 * @param {object} options { baseUrl, token, model, template, files: AiFileInput[], fetchImpl?, onBatch?, useCache? }
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
    const cached = useCache ? aiCache.get(cacheKeyOf(model, template, file)) : undefined
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
      let chunkNames
      try {
        chunkNames = extractJsonArray(await readAiResponseContent(response))
      } catch {
        throw new Error('AI 返回内容无法解析（不是有效的名称列表），可重试或更换模型')
      }
      if (chunkNames.length !== chunk.length) {
        throw new Error(
          `AI 返回数量（${chunkNames.length}）与请求数量（${chunk.length}）不一致，可重试或更换模型`
        )
      }
      chunk.forEach((entry, chunkIndex) => {
        const name = String(chunkNames[chunkIndex]).trim()
        names[entry.index] = name
        aiCache.set(cacheKeyOf(model, template, entry.file), name)
      })
      doneCount += chunk.length
      onBatch?.(doneCount)
    }
  }
  await Promise.all(Array.from({ length: Math.min(AI_BATCH_CONCURRENCY, chunks.length) }, worker))
  return names
}
