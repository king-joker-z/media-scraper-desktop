import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healthScan, checkVideoIntegrity } from '../src/main/modules/health/health.mjs'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'msd-health-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('checkVideoIntegrity returns ok for a valid small video', async () => {
  // 使用 ffmpeg lavfi 生成一个极小的真实视频
  const { spawnSync } = await import('node:child_process')
  const { resolveFfmpegPath } = await import('../src/main/core/frames.mjs')
  const ffmpeg = resolveFfmpegPath()

  await withTempDir(async (dir) => {
    const videoPath = join(dir, 'test.mp4')
    const result = spawnSync(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x48:d=0.5',
      '-pix_fmt',
      'yuv420p',
      '-y',
      videoPath
    ])
    if (result.status !== 0) {
      // ffmpeg 不可用时跳过
      return
    }
    const integrity = await checkVideoIntegrity(videoPath, ffmpeg)
    assert.equal(integrity.ok, true)
  })
})

test('checkVideoIntegrity detects corruption in a truncated file', async () => {
  const { spawnSync } = await import('node:child_process')
  const { resolveFfmpegPath } = await import('../src/main/core/frames.mjs')
  const ffmpeg = resolveFfmpegPath()

  await withTempDir(async (dir) => {
    const videoPath = join(dir, 'valid.mp4')
    const result = spawnSync(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x48:d=1',
      '-pix_fmt',
      'yuv420p',
      '-y',
      videoPath
    ])
    if (result.status !== 0) return

    // 截断文件尾部制造损坏
    const { stat, open } = await import('node:fs/promises')
    const stats = await stat(videoPath)
    const handle = await open(videoPath, 'r+')
    await handle.truncate(Math.floor(stats.size * 0.5))
    await handle.close()

    const integrity = await checkVideoIntegrity(videoPath, ffmpeg)
    assert.equal(integrity.ok, false)
    assert.ok(integrity.error)
  })
})

test('healthScan reports missing poster and nfo for isolated videos', async () => {
  const { spawnSync } = await import('node:child_process')
  const { resolveFfmpegPath } = await import('../src/main/core/frames.mjs')
  const ffmpeg = resolveFfmpegPath()

  await withTempDir(async (root) => {
    const videoPath = join(root, 'lonely.mp4')
    const result = spawnSync(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=64x48:d=0.3',
      '-pix_fmt',
      'yuv420p',
      '-y',
      videoPath
    ])
    if (result.status !== 0) return

    const report = await healthScan(root, { ffmpegPath: ffmpeg })
    assert.equal(report.total, 1)
    assert.equal(report.checked, 1)
    assert.equal(report.corrupted.length, 0)
    assert.ok(report.missingPoster.includes('lonely.mp4'))
    assert.ok(report.missingNfo.includes('lonely.mp4'))
    assert.equal(report.largest.length, 1)
    assert.equal(report.largest[0].relativePath, 'lonely.mp4')
    assert.ok(report.durationMs >= 0)
  })
})

test('healthScan finds poster and nfo when present', async () => {
  const { spawnSync } = await import('node:child_process')
  const { resolveFfmpegPath } = await import('../src/main/core/frames.mjs')
  const ffmpeg = resolveFfmpegPath()

  await withTempDir(async (root) => {
    const videoPath = join(root, 'complete.mp4')
    const result = spawnSync(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x48:d=0.3',
      '-pix_fmt',
      'yuv420p',
      '-y',
      videoPath
    ])
    if (result.status !== 0) return

    // 同层同名 poster 和 nfo
    await writeFile(join(root, 'complete-poster.jpg'), 'fake-image')
    await writeFile(join(root, 'complete.nfo'), '<?xml?><movie/>')

    const report = await healthScan(root, { ffmpegPath: ffmpeg })
    assert.equal(report.total, 1)
    assert.equal(report.missingPoster.length, 0)
    assert.equal(report.missingNfo.length, 0)
  })
})

test('healthScan handles empty workspace', async () => {
  await withTempDir(async (root) => {
    const report = await healthScan(root)
    assert.equal(report.total, 0)
    assert.equal(report.checked, 0)
    assert.deepEqual(report.corrupted, [])
    assert.deepEqual(report.missingPoster, [])
    assert.deepEqual(report.missingNfo, [])
    assert.deepEqual(report.largest, [])
    assert.equal(report.totalBytes, 0)
  })
})
