import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeRename } from '../src/main/modules/rename/execute.mjs'
import { createTaskCenter } from '../src/main/core/task-center.mjs'
import { pathExists } from '../src/main/core/fs-ops.mjs'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'msd-rename-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const center = () => createTaskCenter()

test('renames video and syncs poster to <newStem>-poster.jpg', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'abc@111.mp4'), 'v')
    await writeFile(join(root, 'abc@111-poster.jpg'), 'i')

    const report = await executeRename(
      root,
      [{ videoRel: 'abc@111.mp4', posterRel: 'abc@111-poster.jpg', newStem: '01.abc' }],
      { taskCenter: center(), taskId: 'r1', concurrency: 2 }
    )

    assert.equal(report.failed.length, 0)
    assert.equal(report.renamedCount, 2)
    assert.deepEqual((await readdir(root)).sort(), ['01.abc-poster.jpg', '01.abc.mp4'])
  })
})

test('two-phase rename survives A->B / B->A swap', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'A.mp4'), 'a')
    await writeFile(join(root, 'B.mp4'), 'b')

    const report = await executeRename(
      root,
      [
        { videoRel: 'A.mp4', posterRel: null, newStem: 'B' },
        { videoRel: 'B.mp4', posterRel: null, newStem: 'A' }
      ],
      { taskCenter: center(), taskId: 'r2', concurrency: 2 }
    )

    assert.equal(report.failed.length, 0)
    assert.deepEqual((await readdir(root)).sort(), ['A.mp4', 'B.mp4'])
    // 内容互换成功
    const { readFile } = await import('node:fs/promises')
    assert.equal(await readFile(join(root, 'A.mp4'), 'utf8'), 'b')
    assert.equal(await readFile(join(root, 'B.mp4'), 'utf8'), 'a')
  })
})

test('ext-only mode changes extension without touching stem or poster', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'movie.mkv'), 'v')
    await writeFile(join(root, 'movie-poster.jpg'), 'i')

    const report = await executeRename(
      root,
      [{ videoRel: 'movie.mkv', posterRel: 'movie-poster.jpg', newStem: 'movie', newExt: '.mp4' }],
      { taskCenter: center(), taskId: 'r3', concurrency: 1 }
    )

    assert.equal(report.renamedCount, 1) // 只改视频，poster 不动
    assert.deepEqual((await readdir(root)).sort(), ['movie-poster.jpg', 'movie.mp4'])
  })
})

test('validation failure blocks any write', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'A.mp4'), 'v')

    await assert.rejects(
      executeRename(
        root,
        [{ videoRel: join('sub', 'A.mp4'), posterRel: null, newStem: 'bad/name' }],
        { taskCenter: center(), taskId: 'r4' }
      ),
      /命名校验未通过/
    )
    assert.equal(await pathExists(join(root, 'sub', 'A.mp4')), true)
  })
})

test('no-change pairs are skipped', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'A.mp4'), 'v')
    const report = await executeRename(
      root,
      [{ videoRel: 'A.mp4', posterRel: null, newStem: 'A' }],
      { taskCenter: center(), taskId: 'r5' }
    )
    assert.equal(report.renamedCount, 0)
    assert.deepEqual((await readdir(root)).sort(), ['A.mp4'])
  })
})
