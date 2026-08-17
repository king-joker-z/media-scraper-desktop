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
 * 选择转码目标：优先以最高分辨率的横屏素材作为代表，连同其帧率一起使用。
 * 因此“全合并”混入横竖屏时会产出横屏画布；竖屏片段会按原比例缩放，并在左右补黑边。
 * 若全是竖屏素材，才以最高分辨率竖屏素材为代表。不能把来自不同素材的最大分辨率和最大帧率
 * 拼成不存在的 4K60 目标；这会无谓补帧、放大画面。固定 H.264/MP4 输出为 8-bit 4:2:0，
 * 保证 libx264 与 h264_nvenc 的兼容性；HDR/10-bit 保留需单独走 HEVC 策略。
 */
export function selectQualityTarget(mediaItems) {
  const valid = mediaItems.filter((media) => media?.width > 0 && media?.height > 0)
  if (valid.length === 0) return { width: 1920, height: 1080, fps: 30, pixFmt: 'yuv420p' }
  const landscape = valid.filter((media) => media.width >= media.height)
  const candidates = landscape.length > 0 ? landscape : valid
  const best = candidates.reduce((current, media) => {
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
  const useNvenc = encoder === 'nvenc' || encoder === 'cuda-nvenc'
  const useCudaPipeline = encoder === 'cuda-nvenc'
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
    ...(useCudaPipeline ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : []),
    '-i',
    inputPath,
    ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']),
    '-map',
    '0:v:0',
    '-map',
    hasAudio ? '0:a:0' : '1:a:0',
    '-vf',
    // CUDA 路径从 NVDEC 硬件帧直接缩放/补边后交给 NVENC；任一素材/驱动不支持时主进程按段回退。
    useCudaPipeline
      ? `scale_cuda=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad_cuda=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black`
      : `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
    ...(useCudaPipeline ? ['-aspect', `${target.width}:${target.height}`] : []),
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

/**
 * 合并输出校验：每个片段转码/重封装都会在帧边界与容器时间基上引入少量量化误差。
 * 单片段保留 ±2s 基础容差；多片段按每个拼接边界 50ms 累加（最多 10s），
 * 避免百段短视频的正常累计误差被误判为损坏，同时仍能拒绝明显截断的输出。
 */
export function verifyMergeOutput(outputMedia, items) {
  if (!outputMedia) return { ok: false, note: '输出文件无法读取' }
  if (!outputMedia.videoCodec) return { ok: false, note: '输出缺少视频流' }
  const expectedMs = items.reduce((sum, item) => sum + (item.media?.durationMs ?? 0), 0)
  const diff = Math.abs(outputMedia.durationMs - expectedMs)
  const durationToleranceMs = Math.min(10_000, Math.max(2_000, Math.max(0, items.length - 1) * 50))
  if (diff > durationToleranceMs) {
    return {
      ok: false,
      note: `时长偏差过大：输出 ${(outputMedia.durationMs / 1000).toFixed(1)}s，预期 ${(expectedMs / 1000).toFixed(1)}s（容差 ${(durationToleranceMs / 1000).toFixed(1)}s）`
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
