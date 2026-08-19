/**
 * 重命名纯规则库：不依赖 Node/Electron，main / renderer / node:test 三端共用。
 * 规则以冻结稿 §5 为准。
 */

/** Windows/macOS 均不允许的文件名字符（含 ASCII 控制字符 \x00-\x1f） */
// eslint-disable-next-line no-control-regex
export const ILLEGAL_NAME_RE = /[\x00-\x1f\\/:*?"<>|]/
export const MAX_STEM_LENGTH = 200

/**
 * Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名形式如 CON.txt）。
 * Windows 上这些名字 rename 会报 EINVAL/EPERM，且 NUL 等可能触发设备重定向。
 */
export const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** 名称末尾的点号或空格：Windows 会自动截断导致实际文件名与预期不一致 */
export const TRAILING_DOT_SPACE_RE = /[.\s]$/

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
 * 剥离已有的序号前缀（如 "01."、"02 - "、"003_"），可连续剥离多层。
 * 用于加序号前归零，保证重复执行不会叠加出 "01.01."。
 * 注意保护年份：4-6 位数字仅在紧跟点号分隔符时才视为序号（"2024 演唱会" 不受影响）。
 */
export function stripSeqPrefix(stem) {
  let result = String(stem)
  for (;;) {
    const next = result.replace(/^\d{1,3}\s*[.、．\-_ ]+\s*/, '').replace(/^\d{4,6}[.、．]+\s*/, '')
    if (next === result) return result
    result = next
  }
}

/**
 * 纯序号：生成 "<序号><分隔符><原标题词干>"。
 * @returns {Array<{videoRel: string, newStem: string}>}
 */
export function buildSequenceStems(
  videos,
  { sortBy = 'title', order = 'asc', digits = 2, separator = '.', start = 1 } = {}
) {
  return sortVideos(videos, sortBy, order).map((video, index) => ({
    videoRel: video.relativePath,
    newStem: `${padSeq(index + start, digits)}${separator}${stripSeqPrefix(stemOfName(video.name))}`
  }))
}

/**
 * 为已排序的词干列表添加序号前缀（AI 命名后叠加序号等场景复用）。
 * @param {Array<{videoRel: string, stem: string}>} items 已按期望顺序排列
 * @returns {Array<{videoRel: string, newStem: string}>}
 */
export function withSequencePrefix(items, { digits = 2, separator = '.', start = 1 } = {}) {
  return items.map((item, index) => ({
    videoRel: item.videoRel,
    newStem: `${padSeq(index + start, digits)}${separator}${item.stem}`
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
 * 校验新词干的单项合法性。批内唯一性由 validateRenameTargets 依据完整目标路径处理。
 * @param {Array<{videoRel: string, newStem: string}>} pairs
 * @returns {Record<string, string>} videoRel -> 错误信息（无错误则为空对象）
 */
function validateStemValues(pairs) {
  const errors = {}
  for (const pair of pairs) {
    const stem = pair.newStem ?? ''
    if (!stem.trim()) {
      errors[pair.videoRel] = '名称为空'
      continue
    }
    if (ILLEGAL_NAME_RE.test(stem)) {
      errors[pair.videoRel] = '包含非法字符 \\ / : * ? " < > | 或控制字符'
      continue
    }
    if (WINDOWS_RESERVED_NAME_RE.test(stem)) {
      errors[pair.videoRel] = 'Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9），不可用作文件名'
      continue
    }
    if (TRAILING_DOT_SPACE_RE.test(stem)) {
      errors[pair.videoRel] = '名称末尾不能是点号或空格（Windows 会自动截断）'
      continue
    }
    if (stem.length > MAX_STEM_LENGTH)
      errors[pair.videoRel] = `名称超长（>${MAX_STEM_LENGTH} 字符）`
  }
  return errors
}

/** 保持旧调用方语义：按词干检查批内重名。重命名执行与新 UI 应使用 validateRenameTargets。 */
export function validateStems(pairs) {
  const errors = validateStemValues(pairs)
  const seen = new Map()
  for (const pair of pairs) {
    if (errors[pair.videoRel]) continue
    const key = String(pair.newStem).normalize('NFC').toLocaleLowerCase('en-US')
    if (seen.has(key)) errors[pair.videoRel] = `与「${seen.get(key)}」重名（大小写不敏感）`
    else seen.set(key, pair.videoRel)
  }
  return errors
}

/**
 * 校验完整目标名（目录 + 文件名）是否在批内重复。调用方提供 targetKey，避免共享规则依赖 Node path。
 * 不同扩展名或不同目录允许使用相同词干；同一完整目标才是实际冲突。
 */
export function validateRenameTargets(pairs, getTargetKey) {
  const errors = validateStemValues(pairs)
  const seen = new Map()
  for (const pair of pairs) {
    if (errors[pair.videoRel]) continue
    const targetKeys = getTargetKey(pair)
    for (const targetKey of Array.isArray(targetKeys) ? targetKeys : [targetKeys]) {
      const key = String(targetKey).normalize('NFC').toLocaleLowerCase('en-US')
      if (seen.has(key)) {
        errors[pair.videoRel] = `与「${seen.get(key)}」指向同一目标文件`
        break
      }
      seen.set(key, pair.videoRel)
    }
  }
  return errors
}
