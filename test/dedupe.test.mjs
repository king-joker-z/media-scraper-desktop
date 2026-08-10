import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashFileSample } from '../src/main/core/file-hash.mjs'
import { findDuplicates } from '../src/main/modules/dedupe/dedupe.mjs'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'msd-dedupe-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('hashFileSample: same content same hash, different content different hash', async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, 'a.bin')
    const b = join(dir, 'b.bin')
    const c = join(dir, 'c.bin')
    const content = Buffer.alloc(200_000, 7)
    await writeFile(a, content)
    await writeFile(b, content)
    await writeFile(c, Buffer.alloc(200_000, 9))
    assert.equal(await hashFileSample(a), await hashFileSample(b))
    assert.notEqual(await hashFileSample(a), await hashFileSample(c))
  })
})

test('hashFileSample: mid-file sampling catches head+tail identical files', async () => {
  await withTempDir(async (dir) => {
    // 两个文件头部和尾部完全相同，仅中段不同
    const head = Buffer.alloc(65_536, 1)
    const tail = Buffer.alloc(65_536, 2)
    const midA = Buffer.alloc(65_536, 10)
    const midB = Buffer.alloc(65_536, 20)

    const a = Buffer.concat([head, midA, tail])
    const b = Buffer.concat([head, midB, tail])

    const fileA = join(dir, 'a.bin')
    const fileB = join(dir, 'b.bin')
    await writeFile(fileA, a)
    await writeFile(fileB, b)

    assert.notEqual(await hashFileSample(fileA), await hashFileSample(fileB))
  })
})

test('findDuplicates groups identical videos into exact and ignores uniques', async () => {
  await withTempDir(async (root) => {
    const dup = Buffer.alloc(150_000, 42)
    await writeFile(join(root, '电影A.mp4'), dup)
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', '另一个名字.mkv'), dup) // 内容相同但名字/扩展不同
    await writeFile(join(root, '电影B.mp4'), Buffer.alloc(150_000, 1)) // 同大小不同内容
    await writeFile(join(root, '电影C.mp4'), Buffer.alloc(80_000, 42)) // 不同大小

    const result = await findDuplicates(root)
    assert.equal(result.exact.length, 1)
    assert.equal(result.similar.length, 0)
    assert.deepEqual(
      result.exact[0].items.map((i) => i.relativePath).sort(),
      [join('sub', '另一个名字.mkv'), '电影A.mp4'].sort()
    )
    assert.equal(result.exact[0].sizeBytes, 150_000)
    // 建议保留项指向第一个（按质量排序）
    assert.ok(result.exact[0].keepRel)
  })
})

test('findDuplicates returns empty exact and similar when no duplicates', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'a.mp4'), Buffer.alloc(1000, 1))
    await writeFile(join(root, 'b.mp4'), Buffer.alloc(1000, 2))
    const result = await findDuplicates(root)
    assert.deepEqual(result.exact, [])
    assert.deepEqual(result.similar, [])
  })
})

test('findDuplicates detects similar videos with same resolution and close duration', async () => {
  await withTempDir(async (root) => {
    // 两个同分辨率、时长相近但内容不同的视频
    await writeFile(join(root, 'v1.mp4'), Buffer.alloc(100_000, 1))
    await writeFile(join(root, 'v2.mp4'), Buffer.alloc(120_000, 2))

    const mockProbe = async () => ({
      container: 'mp4',
      durationMs: 60000,
      sizeBytes: 100_000,
      width: 1920,
      height: 1080,
      orientation: 'landscape',
      videoCodec: 'h264',
      audioCodec: 'aac',
      fps: 30,
      pixFmt: 'yuv420p',
      sampleRate: 48000,
      channels: 2
    })

    const result = await findDuplicates(root, { probeFn: mockProbe })
    assert.equal(result.exact.length, 0)
    assert.equal(result.similar.length, 1)
    assert.equal(result.similar[0].key, '1920x1080')
    assert.equal(result.similar[0].items.length, 2)
    // keepRel 指向体积最大的（码率最高）
    assert.equal(result.similar[0].keepRel, 'v2.mp4')
  })
})

test('findDuplicates ignores false positive: same resolution+duration but nearly same size', async () => {
  await withTempDir(async (root) => {
    // 三个不同内容的短视频，分辨率时长一致，体积几乎相同 → 不应误判为相似重复
    await writeFile(join(root, 'a.mp4'), Buffer.alloc(100_000, 1))
    await writeFile(join(root, 'b.mp4'), Buffer.alloc(102_000, 2))
    await writeFile(join(root, 'c.mp4'), Buffer.alloc(98_000, 3))

    const mockProbe = async () => ({
      container: 'mp4',
      durationMs: 6000,
      sizeBytes: 100_000,
      width: 1440,
      height: 960,
      orientation: 'landscape',
      videoCodec: 'h264',
      audioCodec: 'aac',
      fps: 30,
      pixFmt: 'yuv420p',
      sampleRate: 48000,
      channels: 2
    })

    const result = await findDuplicates(root, { probeFn: mockProbe })
    assert.equal(result.exact.length, 0)
    assert.equal(result.similar.length, 0)
  })
})
