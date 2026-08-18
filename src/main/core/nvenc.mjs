import { runPooled } from './ffmpeg-pool.mjs'

/**
 * 验证随应用分发的 FFmpeg、NVIDIA 驱动与显卡是否能实际初始化 H.264 NVENC。
 * 不只检查 encoder 列表，避免「已编译但缺少驱动/无可用设备」的假阳性。
 */
export async function probeNvencCapability(ffmpegPath, { run = runPooled } = {}) {
  try {
    await run(ffmpegPath, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x240:r=30',
      '-frames:v',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p5',
      '-tune',
      'hq',
      '-rc',
      'vbr',
      '-cq',
      '18',
      '-b:v',
      '0',
      '-f',
      'null',
      '-'
    ])
    return { available: true, reason: '' }
  } catch (error) {
    const detail = String(error?.stderrTail || error?.message || '').slice(-500)
    return {
      available: false,
      reason: detail || '随附 FFmpeg、NVIDIA 驱动或显卡无法初始化 H.264 NVENC'
    }
  }
}

/**
 * 验证完整 CUDA 视频路径：GPU 上传、CUDA 缩放/补边与 NVENC 编码。
 * 它是可选加速路径；任何失败都必须回落至稳定的 CPU 滤镜 + NVENC 路径。
 */
export async function probeCudaPipelineCapability(ffmpegPath, { run = runPooled } = {}) {
  try {
    await run(ffmpegPath, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x240:r=30',
      '-frames:v',
      '1',
      '-filter_complex',
      '[0:v]format=nv12,hwupload_cuda,scale_cuda=w=320:h=240,pad_cuda=w=320:h=240:x=0:y=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'h264_nvenc',
      '-pix_fmt',
      'yuv420p',
      '-f',
      'null',
      '-'
    ])
    return { available: true, reason: '' }
  } catch (error) {
    const detail = String(error?.stderrTail || error?.message || '').slice(-500)
    return {
      available: false,
      reason: detail || 'CUDA 上传、缩放、补边或 NVENC 初始化失败'
    }
  }
}

/** 返回供设置页/执行计划使用的实际能力快照。 */
export async function probeGpuCapability(ffmpegPath, options = {}) {
  const [nvenc, cudaPipeline] = await Promise.all([
    probeNvencCapability(ffmpegPath, options),
    probeCudaPipelineCapability(ffmpegPath, options)
  ])
  return { checkedAt: Date.now(), nvenc, cudaPipeline }
}
