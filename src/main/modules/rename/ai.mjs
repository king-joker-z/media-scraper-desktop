/**
 * OpenRouter AI 重命名（冻结稿 §5）：
 * 仅发送文件名与父目录名，绝不上传文件内容。
 */

export const AI_BATCH_SIZE = 50

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
  '新文件名不得包含 \\ / : * ? " < > | 这些字符。'
].join('\n')

/** 模板变量替换（冻结稿：{{parentFolder}} {{fileName}} {{extension}}） */
export function buildPrompt(template, { parentFolder, fileName, extension }) {
  return String(template)
    .replaceAll('{{parentFolder}}', parentFolder)
    .replaceAll('{{fileName}}', fileName)
    .replaceAll('{{extension}}', extension)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 带超时与指数退避重试的 fetch：
 * 网络错误/超时/5xx/429 重试（默认 2 次，1s → 2s），4xx 业务错误不重试。
 */
export async function fetchWithRetry(
  url,
  init,
  { fetchImpl = fetch, retries = 2, timeoutMs = 30_000, retryDelayMs = 1000 } = {}
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
  throw new Error(`网络请求失败（已重试 ${retries} 次）：${lastError?.message ?? lastError}`)
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

const aiCache = new Map()

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
  if (missing.length < files.length) onBatch?.(files.length - missing.length)

  for (let i = 0; i < missing.length; i += AI_BATCH_SIZE) {
    const chunk = missing.slice(i, i + AI_BATCH_SIZE)
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
          temperature: 0.2
        })
      },
      { fetchImpl, retryDelayMs }
    )
    if (!response.ok) {
      throw new Error(`AI 平台请求失败 ${response.status}：${await response.text()}`)
    }
    const data = await response.json()
    const chunkNames = extractJsonArray(data?.choices?.[0]?.message?.content)
    if (chunkNames.length !== chunk.length) {
      throw new Error(`AI 返回数量（${chunkNames.length}）与请求数量（${chunk.length}）不一致`)
    }
    chunk.forEach((entry, chunkIndex) => {
      const name = String(chunkNames[chunkIndex]).trim()
      names[entry.index] = name
      aiCache.set(cacheKeyOf(model, template, entry.file), name)
    })
    onBatch?.(names.filter((n) => n !== undefined).length)
  }
  return names
}
