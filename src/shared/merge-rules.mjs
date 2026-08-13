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
 * 选择转码目标：以最高分辨率的同一条素材作为代表，连同其帧率一起使用。
 * 不能把来自不同素材的最大分辨率和最大帧率拼成不存在的 4K60 目标；这会无谓补帧、放大画面。
 * 固定 H.264/MP4 输出为 8-bit 4:2:0，保证 libx264 与 h264_nvenc 的兼容性；HDR/10-bit 保留需单独走 HEVC 策略。
 */
export function selectQualityTarget(mediaItems) {
  const valid = mediaItems.filter((media) => media?.width > 0 && media?.height > 0)
  if (valid.length === 0) return { width: 1920, height: 1080, fps: 30, pixFmt: 'yuv420p' }
  const best = valid.reduce((current, media) => {
    const currentPixels = current.width * current.height
    const mediaPixels = media.width * media.height
    if (mediaPixels !== currentPixels) return mediaPixels > currentPixels ? media : current
    return (media.fps || 0) > (current.fps || 0) ? media : current
  })
  return {
    width: best.width,
    height: best.height,
    fps: best.fps > 0 ? best.fps : 30,
    pixFmt: 'yuv420p'
  }
}

/**
 * 判定所选片段能否无重编码拼接：与首个片段逐项比对；需要转码时选择最高分辨率代表片段的目标。
 * @param {Array<{media: object|null}>} items 按合并顺序排列
 * @returns {{ compatible: boolean, reasons: string[], target: object|null }}
 */
export function checkCompatibility(items) {
  const probed = items.filter((item) => item.media)
  const unreadable = items.filter((item) => !item.media)
  if (unreadable.length > 0) {
    return {
      compatible: false,
      reasons: unreadable.map((item) => `「${item.name}」媒体信息读取失败，不能安全合并`),
      target: probed.length > 0 ? selectQualityTarget(probed.map((item) => item.media)) : null
    }
  }
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
    target: unique.length === 0 ? null : selectQualityTarget(probed.map((item) => item.media))
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

/** concat 清单文件内容（转义单引号；反斜杠统一为正斜杠） */
export function buildConcatList(paths) {
  return (
    paths
      .map((p) => {
        // ffmpeg concat demuxer 把 \ 视为转义符：Windows 路径必须改用正斜杠，
        // 否则 C:\ws\a.mp4 被解析成 C:wsa.mp4 导致合并失败（官方 FAQ 建议正斜杠）
        const safe = String(p).replaceAll('\\', '/').replace(/'/g, "'\\''")
        return `file '${safe}'`
      })
      .join('\n') + '\n'
  )
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
export function buildTranscodeArgs(
  inputPath,
  target,
  outputPath,
  { encoder = 'cpu', hasAudio = true } = {}
) {
  const useNvenc = encoder === 'nvenc'
  const videoArgs = useNvenc
    ? [
        '-c:v',
        'h264_nvenc',
        // P5 在 40 系列上兼顾吞吐与画质；CQ 18 接近原 CPU 路径 CRF 18 的高质量目标。
        '-preset',
        'p5',
        '-tune',
        'hq',
        '-rc',
        'vbr',
        '-cq',
        '18',
        '-b:v',
        '0'
      ]
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']
  return [
    '-v',
    'error',
    '-i',
    inputPath,
    ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']),
    '-map',
    '0:v:0',
    '-map',
    hasAudio ? '0:a:0' : '1:a:0',
    '-vf',
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-r',
    String(target.fps),
    '-pix_fmt',
    target.pixFmt,
    ...videoArgs,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-ac',
    '2',
    ...(hasAudio ? [] : ['-shortest']),
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

/** 合并输出校验：时长容差 ±2s；全部源有音轨时输出必须含音轨。 */
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
  const audioNote = outputMedia.audioCodec ? '音视频流完整' : '视频流完整（源片段均无音轨）'
  return {
    ok: true,
    note: `校验通过：时长 ${(outputMedia.durationMs / 1000).toFixed(1)}s，${audioNote}`
  }
}
