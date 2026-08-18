import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeVideos, mergeWorkDir } from '../src/main/modules/merge/merge.mjs'
import { checkCompatibility } from '../src/shared/merge-rules.mjs'
import { resolveFfmpegPath } from '../src/main/core/frames.mjs'
import { probeMedia, resolveFfprobePath } from '../src/main/core/probe.mjs'
import { pathExists } from '../src/main/core/fs-ops.mjs'

const execFileAsync = promisify(execFile)

async function makeClip(
  target,
  { seconds = 2, size = '320x240', rate = 10, withAudio = true } = {}
) {
  const args = [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${seconds}:size=${size}:rate=${rate}`
  ]
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`)
  args.push('-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast')
  if (withAudio) args.push('-c:a', 'aac', '-shortest')
  args.push('-y', target)
  await execFileAsync(resolveFfmpegPath(), args)
  return target
}

async function probeItem(path) {
  return { path, name: path.split('/').pop(), media: await probeMedia(path, resolveFfprobePath()) }
}

test('mergeVideos concatenates compatible clips without re-encoding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { seconds: 2 }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { seconds: 3 }))

    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'merged.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath()
    })

    assert.equal(result.error, undefined)
    assert.equal(result.verified, true)
    assert.equal(result.transcoded, false)
    assert.ok(result.outputPath)
    const out = await probeMedia(result.outputPath, resolveFfprobePath())
    // 2s + 3s ≈ 5s（±2s 容差内校验通过）
    assert.ok(Math.abs(out.durationMs - 5000) < 2000, `duration ${out.durationMs}`)
    assert.ok(out.videoCodec)
    assert.ok(out.audioCodec)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos transcodes incompatible clips to unified params', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(
      await makeClip(join(dir, 'a.mp4'), { seconds: 2, size: '320x240', rate: 10 })
    )
    const b = await probeItem(
      await makeClip(join(dir, 'b.mp4'), { seconds: 2, size: '640x480', rate: 24 })
    )

    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'merged.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath()
    })

    assert.equal(result.error, undefined)
    assert.equal(result.verified, true)
    assert.equal(result.transcoded, true)
    const out = await probeMedia(result.outputPath, resolveFfprobePath())
    assert.equal(out.width, 640) // 保留全组最高分辨率，不被首段低清素材拉低
    assert.equal(out.height, 480)
    assert.ok(Math.abs(out.durationMs - 4000) < 2000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos uses a landscape canvas and side black bars for portrait clips in all-merge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const portrait = await probeItem(
      await makeClip(join(dir, 'portrait.mp4'), { seconds: 2, size: '240x320', rate: 10 })
    )
    const landscape = await probeItem(
      await makeClip(join(dir, 'landscape.mp4'), { seconds: 2, size: '640x360', rate: 24 })
    )
    const result = await mergeVideos({
      items: [portrait, landscape],
      outputDir: dir,
      outputName: 'mixed-orientation.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath()
    })

    assert.equal(result.verified, true)
    const output = await probeMedia(result.outputPath, resolveFfprobePath())
    assert.equal(output.width, 640)
    assert.equal(output.height, 360)
    assert.equal(output.orientation, 'landscape')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeWorkDir is deterministic per item set, target, encoder and source version', () => {
  const items = [{ path: '/a/1.mp4' }, { path: '/a/2.mp4' }]
  const versionedItems = [
    { path: '/a/1.mp4', sourceMtimeMs: 100 },
    { path: '/a/2.mp4', sourceMtimeMs: 200 }
  ]
  const updatedItems = [
    { path: '/a/1.mp4', sourceMtimeMs: 101 },
    { path: '/a/2.mp4', sourceMtimeMs: 200 }
  ]
  const target = { width: 1920, height: 1080, fps: 30, pixFmt: 'yuv420p' }
  assert.equal(mergeWorkDir(items, target), mergeWorkDir(items, target))
  assert.notEqual(mergeWorkDir(items, target), mergeWorkDir([{ path: '/a/9.mp4' }], target))
  assert.notEqual(mergeWorkDir(items, target, 'nvenc'), mergeWorkDir(items, target, 'cpu'))
  assert.notEqual(mergeWorkDir(versionedItems, target), mergeWorkDir(updatedItems, target))
})

test('merge keeps workdir on cancel for resume and cleans on success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const clips = []
    for (let i = 0; i < 3; i += 1) {
      clips.push(
        await probeItem(
          await makeClip(join(dir, `r${i}.mp4`), {
            seconds: 15,
            size: i === 0 ? '1280x720' : '640x480'
          })
        )
      )
    }
    const target = checkCompatibility(clips).target
    const versionedClips = await Promise.all(
      clips.map(async (clip) => ({ ...clip, sourceMtimeMs: (await stat(clip.path)).mtimeMs }))
    )
    const workDir = mergeWorkDir(versionedClips, target, 'cpu')

    // 第一次：中途取消 → 临时目录保留
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 400)
    const first = await mergeVideos({
      items: clips,
      outputDir: dir,
      outputName: 'out.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      signal: abort.signal,
      nvencEnabled: false
    })
    assert.equal(first.cancelled, true)
    assert.equal(await pathExists(workDir), true)

    // 第二次：继续执行 → 成功，临时目录被清理
    const second = await mergeVideos({
      items: clips,
      outputDir: dir,
      outputName: 'out.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      nvencEnabled: false
    })
    assert.equal(second.verified, true)
    assert.equal(await pathExists(workDir), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos rejects fewer than two items and non-MP4 outputs before touching files', async () => {
  const baseOptions = {
    outputDir: tmpdir(),
    ffmpegPath: resolveFfmpegPath(),
    ffprobePath: resolveFfprobePath()
  }
  const single = await mergeVideos({
    ...baseOptions,
    items: [{ path: '/not-used/a.mp4', name: '单段', media: null }],
    outputName: 'single.mp4'
  })
  assert.equal(single.verified, false)
  assert.match(single.verifyNote, /至少需要选择两个视频片段/)

  const invalidExtension = await mergeVideos({
    ...baseOptions,
    items: [
      { path: '/not-used/a.mp4', name: 'a', media: null },
      { path: '/not-used/b.mp4', name: 'b', media: null }
    ],
    outputName: 'merged.mkv'
  })
  assert.equal(invalidExtension.verified, false)
  assert.match(invalidExtension.verifyNote, /.mp4 扩展名/)
})

test('mergeVideos refuses to merge items with unreadable media information', async () => {
  const result = await mergeVideos({
    items: [
      { path: '/not-used/a.mp4', name: '正常', media: null },
      { path: '/not-used/b.mp4', name: '异常', media: null }
    ],
    outputDir: tmpdir(),
    outputName: 'never-created.mp4',
    ffmpegPath: resolveFfmpegPath(),
    ffprobePath: resolveFfprobePath()
  })
  assert.equal(result.verified, false)
  assert.match(result.verifyNote, /合并前检查失败/)
  assert.equal(result.error, '正常、异常')
})

test('mergeVideos falls back to CPU when NVENC capability probe rejects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { size: '320x240' }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { size: '640x480' }))
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'probe-error.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      nvencEnabled: true,
      probeNvenc: async () => {
        throw new Error('探测器异常')
      }
    })
    assert.equal(result.verified, true)
    assert.equal(result.videoEncoder, 'cpu')
    assert.match(result.nvencFallbackReason, /探测器异常/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos transcodes a silent clip by adding a compatible silent audio track', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const silent = await probeItem(
      await makeClip(join(dir, 'silent.mp4'), { size: '320x240', withAudio: false })
    )
    const voiced = await probeItem(await makeClip(join(dir, 'voiced.mp4'), { size: '640x480' }))
    const result = await mergeVideos({
      items: [silent, voiced],
      outputDir: dir,
      outputName: 'mixed-audio.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath()
    })
    assert.equal(result.verified, true)
    const output = await probeMedia(result.outputPath, resolveFfprobePath())
    assert.equal(output.audioCodec, 'aac')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos falls back to CPU only when NVENC capability probe fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { size: '320x240' }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { size: '640x480' }))
    let probeCount = 0
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'fallback.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      nvencEnabled: true,
      probeNvenc: async () => {
        probeCount += 1
        return { available: false, reason: '未检测到 NVENC' }
      }
    })
    assert.equal(probeCount, 1)
    assert.equal(result.verified, true)
    assert.equal(result.videoEncoder, 'cpu')
    assert.equal(result.nvencFallbackReason, '未检测到 NVENC')
    assert.match(result.verifyNote, /CPU x264/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos falls back to NVENC + CPU filters when the CUDA pipeline probe rejects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { size: '320x240' }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { size: '640x480' }))
    let cudaProbeCount = 0
    let nvencSegmentCount = 0
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'cuda-probe-fallback.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      nvencEnabled: true,
      cudaPipelineEnabled: true,
      probeNvenc: async () => ({ available: true }),
      probeCudaPipeline: async () => {
        cudaProbeCount += 1
        return { available: false, reason: "Unknown filter 'pad_cuda'" }
      },
      diskFree: async () => Number.MAX_SAFE_INTEGER,
      runFfmpegImpl: async (ffmpegPath, args) => {
        assert.ok(!args.some((arg) => String(arg).includes('pad_cuda')))
        if (args.includes('h264_nvenc')) nvencSegmentCount += 1
        const executableArgs = []
        for (let index = 0; index < args.length; index += 1) {
          const arg = args[index]
          if (['-tune', '-rc', '-cq', '-b:v'].includes(arg)) {
            index += 1
            continue
          }
          if (arg === '-preset') {
            executableArgs.push(arg, 'veryfast')
            index += 1
            continue
          }
          executableArgs.push(arg === 'h264_nvenc' ? 'libx264' : arg)
        }
        await execFileAsync(ffmpegPath, executableArgs)
      }
    })
    assert.equal(cudaProbeCount, 1)
    assert.ok(nvencSegmentCount > 0)
    assert.equal(result.verified, true)
    assert.equal(result.videoEncoder, 'nvenc')
    assert.match(result.verifyNote, /NVIDIA NVENC 编码完成/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos does not probe NVENC for stream-copy merges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4')))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4')))
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'copy.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      nvencEnabled: true,
      probeNvenc: async () => {
        throw new Error('无重编码拼接不应探测 NVENC')
      }
    })
    assert.equal(result.verified, true)
    assert.equal(result.transcoded, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos 在验证通过前不暴露正式输出文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { seconds: 2 }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { seconds: 2 }))
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'staged.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath()
    })
    assert.equal(result.verified, true)
    assert.equal(await pathExists(join(dir, 'staged.mp4')), true)
    const entries = await readdir(dir)
    assert.equal(
      entries.some((name) => name.startsWith('staged.msd-new-')),
      false
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos retries from an isolated CPU workdir after a runtime NVENC failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { size: '320x240' }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { size: '640x480' }))
    let nvencAttempts = 0
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'runtime-fallback.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      nvencEnabled: true,
      probeNvenc: async () => ({ available: true }),
      diskFree: async () => Number.MAX_SAFE_INTEGER,
      runFfmpegImpl: async (ffmpegPath, args) => {
        if (args.includes('h264_nvenc')) {
          nvencAttempts += 1
          throw new Error('h264_nvenc: InitializeEncoder failed while opening encoder')
        }
        await execFileAsync(ffmpegPath, args)
      }
    })
    assert.equal(nvencAttempts, 1)
    assert.equal(result.verified, true)
    assert.equal(result.videoEncoder, 'cpu')
    assert.match(result.nvencFallbackReason, /实际转码时 NVIDIA NVENC 不可用/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos does not reuse a cached segment that violates the unified media contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { seconds: 1, size: '320x240' }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { seconds: 1, size: '640x480' }))
    const target = checkCompatibility([a, b]).target
    const versionedItems = await Promise.all(
      [a, b].map(async (clip) => ({
        ...clip,
        sourceMtimeMs: (await stat(clip.path)).mtimeMs,
        sourceSizeBytes: (await stat(clip.path)).size
      }))
    )
    const workDir = mergeWorkDir(versionedItems, target, 'cpu')
    await mkdir(workDir, { recursive: true })
    await makeClip(join(workDir, 'seg-000.mp4'), { seconds: 1, size: '320x240' })

    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'contract.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      diskFree: async () => Number.MAX_SAFE_INTEGER
    })
    assert.equal(result.verified, true)
    const output = await probeMedia(result.outputPath, resolveFfprobePath())
    assert.equal(output.width, 640)
    assert.equal(output.height, 480)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos keeps output ordering while transcoding segments concurrently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { seconds: 1, size: '320x240' }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { seconds: 1, size: '640x480' }))
    const c = await probeItem(await makeClip(join(dir, 'c.mp4'), { seconds: 1, size: '480x360' }))
    const result = await mergeVideos({
      items: [a, b, c],
      outputDir: dir,
      outputName: 'parallel.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      mergeTranscodeConcurrency: 2,
      diskFree: async () => Number.MAX_SAFE_INTEGER
    })
    assert.equal(result.verified, true)
    assert.equal(result.videoEncoder, 'cpu')
    assert.match(result.tempDirectory, /msd-merge-/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos switches to an isolated CPU workdir after runtime NVENC failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { seconds: 1, size: '320x240' }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { seconds: 1, size: '640x480' }))
    const target = checkCompatibility([a, b]).target
    const versionedItems = await Promise.all(
      [a, b].map(async (clip) => ({
        ...clip,
        sourceMtimeMs: (await stat(clip.path)).mtimeMs,
        sourceSizeBytes: (await stat(clip.path)).size
      }))
    )
    const nvencDir = mergeWorkDir(versionedItems, target, 'nvenc')
    const cpuDir = mergeWorkDir(versionedItems, target, 'cpu')
    let nvencAttempts = 0
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'isolated-fallback.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      nvencEnabled: true,
      probeNvenc: async () => ({ available: true }),
      diskFree: async () => Number.MAX_SAFE_INTEGER,
      runFfmpegImpl: async (ffmpegPath, args) => {
        if (args.includes('h264_nvenc')) {
          nvencAttempts += 1
          throw new Error('h264_nvenc: InitializeEncoder failed while opening encoder')
        }
        await execFileAsync(ffmpegPath, args)
      }
    })
    assert.equal(nvencAttempts, 1)
    assert.equal(result.verified, true)
    assert.equal(result.tempDirectory, cpuDir)
    assert.equal(await pathExists(nvencDir), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos keeps aggregate progress monotonic when segments transcode concurrently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { seconds: 1, size: '320x240' }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { seconds: 1, size: '640x480' }))
    const progress = []
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'monotonic-progress.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      mergeTranscodeConcurrency: 2,
      diskFree: async () => Number.MAX_SAFE_INTEGER,
      onProgress: (percent) => progress.push(percent),
      runFfmpegImpl: async (ffmpegPath, args, options) => {
        const inputIndex = args.indexOf('-i')
        const inputPath = args[inputIndex + 1]
        if (inputPath === a.path) {
          await new Promise((resolve) => setTimeout(resolve, 30))
          options.onProgress?.(50)
        } else if (inputPath === b.path) {
          options.onProgress?.(100)
        }
        await execFileAsync(ffmpegPath, args)
      }
    })
    assert.equal(result.verified, true)
    assert.ok(progress.length > 0)
    assert.deepEqual(
      progress,
      [...progress].sort((left, right) => left - right),
      `进度不应回退：${progress.join(', ')}`
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeWorkDir supports a caller-selected temporary root', () => {
  const target = { width: 640, height: 480, fps: 24, pixFmt: 'yuv420p' }
  const workDir = mergeWorkDir([{ path: '/a.mp4' }], target, 'cpu', '/media/.msd-merge-temp')
  assert.match(workDir, /msd-merge-[a-f0-9]{10}$/)
  assert.ok(workDir.includes('.msd-merge-temp'))
})

test('mergeVideos blocks stream-copy before writing when output disk is insufficient', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4')))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4')))
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'copy-no-space.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      diskFree: async () => 0
    })
    assert.equal(result.verified, false)
    assert.match(result.verifyNote, /输出盘可用空间不足/)
    assert.equal(await pathExists(join(dir, 'copy-no-space.mp4')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos blocks transcode before writing when temp or output disk is insufficient', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { size: '320x240' }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { size: '640x480' }))
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'no-space.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      diskFree: async () => 0
    })
    assert.equal(result.verified, false)
    assert.match(result.verifyNote, /临时目录与输出目录所在磁盘.*空间不足/)
    assert.equal(await pathExists(join(dir, 'no-space.mp4')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos blocks transcode using combined peak space when temp and output share a volume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { size: '320x240' }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { size: '640x480' }))
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'same-volume-no-space.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      diskFree: async () => 100 * 1024 * 1024,
      volumeId: async () => 'same-volume'
    })
    assert.equal(result.verified, false)
    assert.match(result.verifyNote, /临时目录与输出目录所在磁盘.*空间不足/)
    assert.equal(await pathExists(join(dir, 'same-volume-no-space.mp4')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos returns a diagnostic result when disk space preflight cannot access a directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const a = await probeItem(await makeClip(join(dir, 'a.mp4'), { size: '320x240' }))
    const b = await probeItem(await makeClip(join(dir, 'b.mp4'), { size: '640x480' }))
    const inaccessible = Object.assign(new Error('network share unavailable'), { code: 'ENOTCONN' })
    const result = await mergeVideos({
      items: [a, b],
      outputDir: dir,
      outputName: 'network-error.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      diskFree: async () => {
        throw inaccessible
      }
    })
    assert.equal(result.verified, false)
    assert.match(result.verifyNote, /无法读取临时目录或输出目录的可用空间/)
    assert.match(result.error, /network share unavailable/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeVideos cancellation cleans up partial output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msd-merge-'))
  try {
    const clips = []
    // 参数不一致 → 走较慢的转码路径，取消才来得及生效
    for (let i = 0; i < 4; i += 1) {
      clips.push(
        await probeItem(
          await makeClip(join(dir, `c${i}.mp4`), {
            seconds: 10,
            size: i === 0 ? '1280x720' : '640x480'
          })
        )
      )
    }
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 700)
    const result = await mergeVideos({
      items: clips,
      outputDir: dir,
      outputName: 'merged.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      signal: abort.signal
    })
    assert.equal(result.cancelled, true)
    assert.equal(await pathExists(join(dir, 'merged.mp4')), false)
    // 源文件未被动过
    assert.equal(await pathExists(join(dir, 'c0.mp4')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
