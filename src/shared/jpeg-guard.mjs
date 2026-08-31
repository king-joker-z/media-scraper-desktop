/**
 * JPEG 结构完整性扫描（纯函数、零依赖，main / renderer / node:test 三端共用）。
 *
 * 背景：部分下载源（如站内打包图）的 JPEG 在 SOS 标记前或熵编码段内夹带大量垃圾字节，
 * libjpeg 会发出「Corrupt JPEG data: NNNN extraneous bytes before marker 0xXX」告警；
 * sharp 0.35 默认 failOn='warning' 会把这类告警升级为抛错，导致漫画合并整本失败。
 * 本模块按 JPEG 规范遍历标记流，识别需要转码修复的结构异常，供合并前做「坏图自动修复」。
 *
 * 只识别可证明的非标准结构，不解析熵编码内容：
 * - junk-before-sos：SOS 之前、段与段之间出现非 0xFF 字节（0xda 场景）；
 * - junk-in-scan：熵编码段内 0xFF 后跟非 0x00/RST/EOI/合法段标记的字节（0xd0 场景）；
 * - trailing-data：EOI 之后的额外字节（解码器普遍宽容，不触发修复）；
 * - truncated：段长度越界、扫描数据未遇 EOI 即到文件尾；
 * - nested-soi：头部出现第二个 SOI；
 * - bad-length：段长度字段非法（<2 或截断）。
 */

const SOI = 0xd8
const EOI = 0xd9
const SOS = 0xda
const TEM = 0x01
const RST0 = 0xd0
const RST7 = 0xd7
// 渐进式 JPEG 的 SOF2；此类文件有多个 SOS 扫描段，段间可出现 DHT/DQT/DRI 等标记
const SOF_PROGRESSIVE = 0xc2

/** 读取带长度字段的段长度（含 2 字节长度字段本身）；越界/非法返回 null。 */
const readSegmentLength = (bytes, pos, len) => {
  if (pos + 2 > len) return null
  const segLen = (bytes[pos] << 8) | bytes[pos + 1]
  return segLen >= 2 ? segLen : null
}

/**
 * 头部阶段（SOI 之后、首个 SOS 之前）标记流遍历。
 * @returns {{pos: number, progressive: boolean}} pos 为 SOS 段之后或 EOI 之后的位置
 */
function walkHeader(bytes, pos, len, anomalies) {
  let progressive = false
  while (pos < len) {
    // 段与段之间非 0xFF 的字节即垃圾（libjpeg 统计为 extraneous bytes）
    const junkStart = pos
    while (pos < len && bytes[pos] !== 0xff) pos += 1
    const junk = pos - junkStart
    // 0xFF 填充（连续 0xFF 是合法填充）
    while (pos < len && bytes[pos] === 0xff) pos += 1
    if (pos >= len) {
      anomalies.push({ kind: 'truncated', offset: len, bytes: 0 })
      return { pos, progressive }
    }
    const marker = bytes[pos]
    pos += 1
    if (junk > 0) anomalies.push({ kind: 'junk-before-sos', offset: junkStart, bytes: junk })

    if (marker === SOS) {
      // 长度值含 2 字节长度字段本身，pos 正指向长度字段：整段占 segLen 字节
      const segLen = readSegmentLength(bytes, pos, len)
      if (segLen === null || pos + segLen > len) {
        anomalies.push({ kind: 'truncated', offset: pos, bytes: 0 })
        return { pos, progressive }
      }
      pos += segLen
      return { pos, progressive }
    }
    if (marker === EOI) return { pos, progressive }
    if (marker === SOI) {
      anomalies.push({ kind: 'nested-soi', offset: pos - 1, bytes: 0 })
      continue
    }
    if (marker === TEM || (marker >= RST0 && marker <= RST7)) continue
    if (marker === SOF_PROGRESSIVE) progressive = true
    // 常规带长度段（SOF/DHT/DQT/APPn/COM/DRI…）
    const segLen = readSegmentLength(bytes, pos, len)
    if (segLen === null || pos + segLen > len) {
      anomalies.push({ kind: 'truncated', offset: pos, bytes: 0 })
      return { pos, progressive }
    }
    pos += segLen
  }
  return { pos, progressive }
}

/**
 * 熵编码段遍历（SOS 之后到 EOI/文件尾）。
 * 非 0xFF 字节是合法熵数据；0xFF 后必须是 0x00（字节填充）、RST、EOI，
 * 渐进式 JPEG 还允许段间出现 SOS/带长度段标记。其余视为垃圾。
 * @returns EOI 之后的位置（未遇 EOI 时为文件尾）
 */
function walkScan(bytes, pos, len, anomalies, progressive) {
  while (pos < len) {
    const ff = bytes.indexOf(0xff, pos)
    if (ff === -1) {
      anomalies.push({ kind: 'truncated', offset: len, bytes: 0 })
      return len
    }
    // 统计连续的 0xFF：首个是标记引导，其余为填充/垃圾
    let run = 0
    let p = ff
    while (p < len && bytes[p] === 0xff) {
      run += 1
      p += 1
    }
    if (p >= len) {
      anomalies.push({ kind: 'truncated', offset: len, bytes: 0 })
      return len
    }
    const code = bytes[p]
    const pushJunk = () => {
      if (run > 1) anomalies.push({ kind: 'junk-in-scan', offset: ff, bytes: run - 1 })
    }
    if (code === 0x00) {
      pushJunk() // 多余 0xFF 填充属于垃圾
      pos = p + 1
      continue
    }
    if (code >= RST0 && code <= RST7) {
      pushJunk()
      pos = p + 1
      continue
    }
    if (code === EOI) {
      pushJunk()
      return p + 1
    }
    if (code === SOS) {
      // 多扫描段（渐进式必需）：读取段长度后继续
      pushJunk()
      const segLen = readSegmentLength(bytes, p + 1, len)
      if (segLen === null || p + 1 + segLen > len) {
        anomalies.push({ kind: 'truncated', offset: p, bytes: 0 })
        return len
      }
      pos = p + 1 + segLen
      continue
    }
    if (progressive && code !== SOI) {
      // 渐进式 JPEG 段间允许 DHT/DQT/DRI/COM/APPn 等带长度段
      const segLen = readSegmentLength(bytes, p + 1, len)
      if (segLen !== null && p + 1 + segLen <= len) {
        pushJunk()
        pos = p + 1 + segLen
        continue
      }
    }
    // 非法码：整段 0xFF 序列 + 该字节都是垃圾，跳过继续
    anomalies.push({ kind: 'junk-in-scan', offset: ff, bytes: run })
    pos = p + 1
  }
  anomalies.push({ kind: 'truncated', offset: len, bytes: 0 })
  return len
}

/**
 * 分析 JPEG 字节流的结构完整性。
 * @param {Uint8Array | Buffer} bytes
 * @returns {{jpeg: boolean, anomalies: Array<{kind: string, offset: number, bytes: number}>}}
 *   jpeg=false 表示不是以 SOI 开头的 JPEG（可能被改名/损坏，但无法结构判定）；
 *   anomalies 按出现顺序排列，可能为空。
 */
export function analyzeJpeg(bytes) {
  const len = bytes.length
  if (len < 2 || bytes[0] !== 0xff || bytes[1] !== SOI) {
    return { jpeg: false, anomalies: [] }
  }
  const anomalies = []
  const header = walkHeader(bytes, 2, len, anomalies)
  let pos = header.pos
  if (pos < len) pos = walkScan(bytes, pos, len, anomalies, header.progressive)
  if (pos < len) anomalies.push({ kind: 'trailing-data', offset: pos, bytes: len - pos })
  return { jpeg: true, anomalies }
}

/**
 * 是否需要转码修复：不是 JPEG（以 .jpg 命名但内容不符）或存在除
 * trailing-data 外的结构异常。trailing-data 解码器普遍宽容且极常见，
 * 修复它会让「原样」模式失去保留源字节的意义，故不触发。
 * @param {Uint8Array | Buffer} bytes
 * @returns {boolean}
 */
export function needsJpegRepair(bytes) {
  const { jpeg, anomalies } = analyzeJpeg(bytes)
  if (!jpeg) return true
  return anomalies.some((item) => item.kind !== 'trailing-data')
}
