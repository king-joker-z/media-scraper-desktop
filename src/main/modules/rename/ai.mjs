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

/**
 * 请求 AI 平台（OpenAI 兼容端点）生成新文件名。
 * @param {object} options { baseUrl, token, model, template, files: AiFileInput[], fetchImpl? }
 * @returns {Promise<string[]>} 与 files 等长的新词干数组
 */
export async function requestAiNames({
  baseUrl,
  token,
  model,
  template,
  files,
  fetchImpl = fetch,
  onBatch
}) {
  if (!token) throw new Error('当前平台未配置 API Token，请先到设置页填写')
  if (!baseUrl) throw new Error('当前平台未配置 baseUrl')
  if (files.length === 0) return []

  const names = []
  for (let i = 0; i < files.length; i += AI_BATCH_SIZE) {
    const chunk = files.slice(i, i + AI_BATCH_SIZE)
    const response = await fetchImpl(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/king-joker-z/media-scraper-desktop',
        'X-Title': 'Media Scraper'
      },
      body: JSON.stringify({
        model,
        messages: buildAiMessages(template, chunk),
        temperature: 0.2
      })
    })
    if (!response.ok) {
      throw new Error(`AI 平台请求失败 ${response.status}：${await response.text()}`)
    }
    const data = await response.json()
    const chunkNames = extractJsonArray(data?.choices?.[0]?.message?.content)
    if (chunkNames.length !== chunk.length) {
      throw new Error(`AI 返回数量（${chunkNames.length}）与请求数量（${chunk.length}）不一致`)
    }
    names.push(...chunkNames.map((name) => String(name).trim()))
    onBatch?.(names.length)
  }
  return names
}
