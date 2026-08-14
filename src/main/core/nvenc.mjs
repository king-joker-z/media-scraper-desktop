import { runPooled } from './ffmpeg-pool.mjs'

/**
 * 验证随应用分发的 FFmpeg、NVIDIA 驱动与显卡是否能实际初始化 H.264 NVENC。
 * 仅检查 encoder 列表无法覆盖「已编译但缺少驱动 / 无可用设备 / 正式编码参数不兼容」的情况，因此使用实际参数的 lavfi 编码烟测。
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
      // NVENC 对最小编码尺寸有要求；16×16 虽可由软件编码器处理，
      // 却会在部分 Windows 驱动上以无效参数拒绝初始化，造成假阴性回退 CPU。
      // 使用常见的 320×240 规格，使烟测与实际合并路径保持一致。
      'color=c=black:s=320x240:r=30',
      '-frames:v',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'h264_nvenc',
      // 与实际合并的 NVENC 参数一致，避免“基础编码可用、正式任务参数不兼容”的假阳性。
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
