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

test('findDuplicates groups identical videos and ignores uniques', async () => {
  await withTempDir(async (root) => {
    const dup = Buffer.alloc(150_000, 42)
    await writeFile(join(root, '电影A.mp4'), dup)
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', '另一个名字.mkv'), dup) // 内容相同但名字/扩展不同
    await writeFile(join(root, '电影B.mp4'), Buffer.alloc(150_000, 1)) // 同大小不同内容
    await writeFile(join(root, '电影C.mp4'), Buffer.alloc(80_000, 42)) // 不同大小

    const groups = await findDuplicates(root)
    assert.equal(groups.length, 1)
    assert.deepEqual(
      groups[0].items.map((i) => i.relativePath).sort(),
      ['sub/另一个名字.mkv', '电影A.mp4'].sort()
    )
    assert.equal(groups[0].sizeBytes, 150_000)
  })
})

test('findDuplicates returns empty when no duplicates', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'a.mp4'), Buffer.alloc(1000, 1))
    await writeFile(join(root, 'b.mp4'), Buffer.alloc(1000, 2))
    assert.deepEqual(await findDuplicates(root), [])
  })
})
