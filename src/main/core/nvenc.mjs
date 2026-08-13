import { runPooled } from './ffmpeg-pool.mjs'

/**
 * 验证随应用分发的 FFmpeg、NVIDIA 驱动与显卡是否能实际初始化 H.264 NVENC。
 * 仅检查 encoder 列表无法覆盖「已编译但缺少驱动 / 无可用设备」的情况，因此使用最小 lavfi 编码烟测。
 * CUDA 解码和 GPU 滤镜不是此能力的前提：视频合并的稳定路径仍由 CPU 解码、缩放和补边，仅卸载编码。
 */
export async function probeNvencCapability(ffmpegPath, { run = runPooled } = {}) {
  try {
    await run(ffmpegPath, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=16x16:r=1',
      '-frames:v',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'h264_nvenc',
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
