import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScanPlan } from '../src/main/core/scanner.mjs'
import { pathExists } from '../src/main/core/fs-ops.mjs'
import { convertToJpg } from '../src/main/core/image.mjs'
import {
  computePendingSaves,
  framesDirFor,
  listPosterVideos,
  mapPosterVideos,
  savePoster,
  videoStem
} from '../src/main/modules/poster/poster.mjs'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'msd-poster-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('mapPosterVideos links videos with existing posters', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'A.mp4'), 'v')
    await writeFile(join(root, 'A-poster.jpg'), 'i')
    await writeFile(join(root, 'B.mp4'), 'v')

    const plan = await createScanPlan(root)
    const videos = mapPosterVideos(plan)
    assert.equal(videos.length, 2)
    const a = videos.find((v) => v.name === 'A.mp4')
    const b = videos.find((v) => v.name === 'B.mp4')
    assert.equal(a.posterRelativePath, 'A-poster.jpg')
    assert.equal(b.posterPath, null)
  })
})

test('listPosterVideos returns videos from a real workspace', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'C.mp4'), 'v')
    const videos = await listPosterVideos(root)
    assert.equal(videos.length, 1)
    assert.equal(videos[0].posterPath, null)
  })
})

test('savePoster converts frame to <stem>-poster.jpg and removes old poster', async () => {
  await withTempDir(async (root) => {
    const video = join(root, 'Movie.mp4')
    await writeFile(video, 'v')
    const oldPoster = join(root, 'Movie-old.jpg')
    await writeFile(oldPoster, 'old')

    // 模拟一帧候选（png 转 jpg 的临时帧）
    const framesDir = framesDirFor(join(root, 'frames'), video)
    await mkdir(framesDir, { recursive: true })
    const framePng = join(framesDir, 'candidate.png')
    const frameJpg = join(framesDir, 'candidate.jpg')
    await writeFile(framePng, Buffer.from(PNG_BASE64, 'base64'))
    await convertToJpg(framePng, frameJpg)

    const result = await savePoster({
      videoPath: video,
      chosenFramePath: frameJpg,
      oldPosterPath: oldPoster
    })

    assert.equal(result.saved, join(root, 'Movie-poster.jpg'))
    assert.deepEqual(result.deletedOld, [oldPoster])
    // 新封面是真实 JPEG
    const bytes = await readFile(result.saved)
    assert.equal(bytes[0], 0xff)
    assert.equal(bytes[1], 0xd8)
    // 旧封面已删，临时目录已清理
    assert.equal(await pathExists(oldPoster), false)
    assert.equal(await pathExists(framesDir), false)
  })
})

test('savePoster is a no-op when choosing the current poster itself', async () => {
  await withTempDir(async (root) => {
    const video = join(root, 'Movie.mp4')
    await writeFile(video, 'v')
    const poster = join(root, 'Movie-poster.jpg')
    await writeFile(poster, 'original-bytes')

    const result = await savePoster({
      videoPath: video,
      chosenFramePath: poster,
      oldPosterPath: poster
    })
    assert.equal(result.saved, poster)
    // 内容未被重写
    assert.equal(await readFile(poster, 'utf8'), 'original-bytes')
  })
})

test('videoStem strips extension', () => {
  assert.equal(videoStem('/a/b/Movie.Name.mp4'), 'Movie.Name')
})

test('computePendingSaves only includes videos whose selection differs from current poster', () => {
  const videos = [
    {
      path: '/r/A.mp4',
      relativePath: 'A.mp4',
      name: 'A.mp4',
      size: 1,
      posterPath: null,
      posterRelativePath: null
    },
    {
      path: '/r/B.mp4',
      relativePath: 'B.mp4',
      name: 'B.mp4',
      size: 1,
      posterPath: '/r/B-poster.jpg',
      posterRelativePath: 'B-poster.jpg'
    },
    {
      path: '/r/C.mp4',
      relativePath: 'C.mp4',
      name: 'C.mp4',
      size: 1,
      posterPath: '/r/C-poster.jpg',
      posterRelativePath: 'C-poster.jpg'
    }
  ]
  const selections = {
    'A.mp4': '/tmp/frames/a1.jpg', // 无封面选了候选帧 → 待保存
    'B.mp4': '/tmp/frames/b1.jpg', // 有封面但换了帧 → 待保存
    'C.mp4': '/r/C-poster.jpg' // 选择与原封面一致 → 不保存
  }
  const pending = computePendingSaves(videos, selections)
  assert.equal(pending.length, 2)
  assert.deepEqual(pending.map((p) => p.relativePath).sort(), ['A.mp4', 'B.mp4'])
  assert.equal(pending.find((p) => p.relativePath === 'B.mp4').oldPosterPath, '/r/B-poster.jpg')
  // 未选择的视频也不进入待保存
  assert.equal(computePendingSaves(videos, {}).length, 0)
})
