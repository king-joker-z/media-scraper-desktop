import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
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
    assert.equal(out.width, 320) // 统一到首个片段
    assert.equal(out.height, 240)
    assert.ok(Math.abs(out.durationMs - 4000) < 2000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeWorkDir is deterministic per item set and target', () => {
  const items = [{ path: '/a/1.mp4' }, { path: '/a/2.mp4' }]
  const target = { width: 1920, height: 1080, fps: 30, pixFmt: 'yuv420p' }
  assert.equal(mergeWorkDir(items, target), mergeWorkDir(items, target))
  assert.notEqual(mergeWorkDir(items, target), mergeWorkDir([{ path: '/a/9.mp4' }], target))
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
    const workDir = mergeWorkDir(clips, target)

    // 第一次：中途取消 → 临时目录保留
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 400)
    const first = await mergeVideos({
      items: clips,
      outputDir: dir,
      outputName: 'out.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath(),
      signal: abort.signal
    })
    assert.equal(first.cancelled, true)
    assert.equal(await pathExists(workDir), true)

    // 第二次：继续执行 → 成功，临时目录被清理
    const second = await mergeVideos({
      items: clips,
      outputDir: dir,
      outputName: 'out.mp4',
      ffmpegPath: resolveFfmpegPath(),
      ffprobePath: resolveFfprobePath()
    })
    assert.equal(second.verified, true)
    assert.equal(await pathExists(workDir), false)
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
