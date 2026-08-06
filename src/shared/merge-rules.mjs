/**
 * 视频合并纯规则库（冻结稿 §4）：不依赖 Node/Electron，三端共用。
 */

/** concat 无重编码拼接要求的关键参数集合 */
const COMPARE_FIELDS = [
  ['container', '容器格式'],
  ['videoCodec', '视频编码'],
  ['width', '分辨率(宽)'],
  ['height', '分辨率(高)'],
  ['pixFmt', '像素格式'],
  ['audioCodec', '音频编码'],
  ['sampleRate', '音频采样率'],
  ['channels', '音频声道']
]

/**
 * 判定所选片段能否无重编码拼接：与首个片段逐项比对。
 * @param {Array<{media: object|null}>} items 按合并顺序排列
 * @returns {{ compatible: boolean, reasons: string[], target: object|null }}
 */
export function checkCompatibility(items) {
  const probed = items.filter((item) => item.media)
  if (probed.length <= 1) {
    return { compatible: true, reasons: [], target: null }
  }
  const first = probed[0].media
  const reasons = []
  for (const item of probed.slice(1)) {
    for (const [field, label] of COMPARE_FIELDS) {
      const a = first[field] ?? null
      const b = item.media[field] ?? null
      if (a !== b) {
        reasons.push(`「${item.name}」${label}不一致（${a} vs ${b}）`)
      }
    }
    // fps 容差 0.5（容器时间基差异）
    if (Math.abs((first.fps ?? 0) - (item.media.fps ?? 0)) > 0.5) {
      reasons.push(`「${item.name}」帧率不一致（${first.fps} vs ${item.media.fps}）`)
    }
  }
  const unique = [...new Set(reasons)]
  return {
    compatible: unique.length === 0,
    reasons: unique,
    target:
      unique.length === 0
        ? null
        : {
            width: first.width,
            height: first.height,
            fps: first.fps || 30,
            pixFmt: first.pixFmt || 'yuv420p'
          }
  }
}

/** 估算输出大小：无重编码 = Σ源大小；转码 = 最高源码率 × 总时长 × 1.1 余量 */
export function estimateOutputBytes(items, compatible) {
  const probed = items.filter((item) => item.media)
  const totalBytes = probed.reduce((sum, item) => sum + (item.media.sizeBytes || 0), 0)
  if (compatible) return totalBytes
  let maxBitrate = 0
  let totalSeconds = 0
  for (const item of probed) {
    const seconds = item.media.durationMs / 1000
    totalSeconds += seconds
    if (seconds > 0) maxBitrate = Math.max(maxBitrate, item.media.sizeBytes / seconds)
  }
  return Math.round((maxBitrate * totalSeconds * 1.1) / 8) * 8 || totalBytes * 2
}

/** 输出文件名（冻结稿 §4：以工作区目录名命名） */
export function mergeOutputName(workspaceName, mode) {
  const suffix =
    mode === 'landscape'
      ? '-landscape-merged'
      : mode === 'portrait'
        ? '-portrait-merged'
        : '-merged'
  return `${workspaceName}${suffix}.mp4`
}

/** 判断是否为本产品生成的合并产物（扫描时排除，避免产物再次参与合并） */
export const isMergeOutputName = (name) =>
  /-(landscape-|portrait-|custom-)?merged( \(\d+\))?\.mp4$/i.test(name)

/** concat 清单文件内容（转义单引号） */
export function buildConcatList(paths) {
  return paths.map((p) => `file '${String(p).replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

/** 无重编码拼接参数 */
export function buildConcatCopyArgs(listPath, outputPath) {
  return [
    '-v',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]
}

/** 单段转码为统一参数的中间 MP4（与最终容器一致，避免 ADTS/位流过滤器问题） */
export function buildTranscodeArgs(inputPath, target, outputPath) {
  return [
    '-v',
    'error',
    '-i',
    inputPath,
    '-vf',
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-r',
    String(target.fps),
    '-pix_fmt',
    target.pixFmt,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-y',
    outputPath
  ]
}

/** 转码后中间片段（MP4）合并为最终 MP4 */
export function buildConcatSegmentsArgs(listPath, outputPath) {
  return [
    '-v',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]
}

/** 合并输出校验：时长容差 ±2s；全部源有音轨时输出必须含音轨 */
export function verifyMergeOutput(outputMedia, items) {
  if (!outputMedia) return { ok: false, note: '输出文件无法读取' }
  if (!outputMedia.videoCodec) return { ok: false, note: '输出缺少视频流' }
  const expectedMs = items.reduce((sum, item) => sum + (item.media?.durationMs ?? 0), 0)
  const diff = Math.abs(outputMedia.durationMs - expectedMs)
  if (diff > 2000) {
    return {
      ok: false,
      note: `时长偏差过大：输出 ${(outputMedia.durationMs / 1000).toFixed(1)}s，预期 ${(expectedMs / 1000).toFixed(1)}s`
    }
  }
  const allHadAudio = items.every((item) => item.media?.audioCodec)
  if (allHadAudio && !outputMedia.audioCodec) {
    return { ok: false, note: '输出丢失音轨' }
  }
  return {
    ok: true,
    note: `校验通过：时长 ${(outputMedia.durationMs / 1000).toFixed(1)}s，音视频流完整`
  }
}
