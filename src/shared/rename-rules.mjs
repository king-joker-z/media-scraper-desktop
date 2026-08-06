/**
 * 重命名纯规则库：不依赖 Node/Electron，main / renderer / node:test 三端共用。
 * 规则以冻结稿 §5 为准。
 */

/** Windows/macOS 均不允许的文件名字符 */
export const ILLEGAL_NAME_RE = /[\\/:*?"<>|]/
export const MAX_STEM_LENGTH = 200

export const stemOfName = (name) => name.replace(/\.[^.]+$/, '')
export const extOfName = (name) => name.slice(name.lastIndexOf('.'))

export const padSeq = (n, digits) => String(n).padStart(Math.max(1, digits), '0')

/** 标题排序：数字感知（视频 2 < 视频 10），中文按拼音 */
export const compareTitles = (a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true })

/**
 * 排序视频列表。
 * @param {Array} videos 含 name/size 的对象数组
 * @param {'title'|'size'} sortBy
 * @param {'asc'|'desc'} order
 */
export function sortVideos(videos, sortBy = 'title', order = 'asc') {
  const sorted = [...videos].sort((a, b) => {
    if (sortBy === 'size') return a.size - b.size || compareTitles(a.name, b.name)
    return compareTitles(stemOfName(a.name), stemOfName(b.name))
  })
  return order === 'desc' ? sorted.reverse() : sorted
}

/**
 * 纯序号：生成 "<序号><分隔符><原标题词干>"。
 * @returns {Array<{videoRel: string, newStem: string}>}
 */
export function buildSequenceStems(
  videos,
  { sortBy = 'title', order = 'asc', digits = 2, separator = '.' } = {}
) {
  return sortVideos(videos, sortBy, order).map((video, index) => ({
    videoRel: video.relativePath,
    newStem: `${padSeq(index + 1, digits)}${separator}${stemOfName(video.name)}`
  }))
}

/**
 * 依次应用正则规则清洗词干；非法规则跳过。
 * @param {string} stem
 * @param {Array<{pattern: string, replacement: string, flags: string}>} rules
 */
export function applyRegexRules(stem, rules) {
  let result = stem
  for (const rule of rules) {
    try {
      result = result.replace(new RegExp(rule.pattern, rule.flags || 'g'), rule.replacement ?? '')
    } catch {
      // 非法正则跳过，不中断
    }
  }
  return result.replace(/\s{2,}/g, ' ').trim()
}

/**
 * 校验新词干（冻结稿 §5：非法字符、空名、超长、大小写冲突、批内重名）。
 * @param {Array<{videoRel: string, newStem: string}>} pairs
 * @returns {Record<string, string>} videoRel -> 错误信息（无错误则为空对象）
 */
export function validateStems(pairs) {
  const errors = {}
  const seen = new Map()
  for (const pair of pairs) {
    const stem = pair.newStem ?? ''
    if (!stem.trim()) {
      errors[pair.videoRel] = '名称为空'
      continue
    }
    if (ILLEGAL_NAME_RE.test(stem)) {
      errors[pair.videoRel] = '包含非法字符 \\ / : * ? " < > |'
      continue
    }
    if (stem.length > MAX_STEM_LENGTH) {
      errors[pair.videoRel] = `名称超长（>${MAX_STEM_LENGTH} 字符）`
      continue
    }
    const key = stem.toLowerCase()
    if (seen.has(key)) {
      errors[pair.videoRel] = `与「${seen.get(key)}」重名（大小写不敏感）`
      continue
    }
    seen.set(key, pair.videoRel)
  }
  return errors
}
